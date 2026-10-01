import { config } from "./config";
import { db, kvGet, kvSet } from "./db";
import { addLogSink, log } from "./log";
import { bookFromPrice, SigClient, sigClient, toSigMarket } from "./sigClient";
import { externalCached } from "./external";
import {
  headlinesUpTo,
  insertDecision,
  insertFill,
  logRow,
  storeBook,
  storeExternal,
  storeNews,
  upsertMarkets,
  upsertOrder,
} from "./store";
import type { ExternalQuote, NewsHeadline, SigMarket, YesBook } from "../core/types";
import { bookStats } from "../core/orderbook";
import { computeSignals, mergeStrategy, runPortfolioTick, type StrategyConfig } from "../core/engine";
import { Portfolio } from "../core/portfolio";
import { PaperExecutionClient } from "../core/execution";
import { raceId } from "../core/races";
import type { ScenarioRules } from "../core/sizing";

// Data collector: polls SIG inside the published rate limit, stores order books, external
// reference quotes and news headlines, and optionally runs the paper-trading strategy live.
// Runs inside the Node server process (local laptop on Day 1, a VPS/container on Day 2).

export interface CollectorStatus {
  running: boolean;
  runId: number | null;
  startedAt: string | null;
  lastTickAt: string | null;
  ticks: number;
  markets: number;
  depthBooks: number;
  paperTrading: boolean;
  strategy: string;
  lastError: string | null;
  readsLastMinute: number;
  readBudgetPerMinute: number;
  rateLimited: number;
  priceIntervalSec: number;
  headlinesSeen: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Collector {
  running = false;
  runId: number | null = null;
  startedAt: string | null = null;
  lastTickAt: string | null = null;
  ticks = 0;
  lastError: string | null = null;
  paperTrading = false;
  strategy: StrategyConfig = mergeStrategy({ name: "live-paper" });

  markets: SigMarket[] = [];
  books = new Map<string, YesBook>();
  depthFetchedAt = new Map<string, number>();
  external = new Map<string, ExternalQuote[]>();
  headlines = new Map<string, NewsHeadline[]>();
  prevMids = new Map<string, number>();
  tournamentId: string | null = null;
  private lastMarketsAt = 0;
  private lastExternalAt = 0;
  private newsCursor = 0;
  private newsCredit = 0;
  private loop: Promise<void> | null = null;
  private unsink: (() => void) | null = null;

  portfolio: Portfolio | null = null;
  exec: PaperExecutionClient | null = null;
  tradedHeadlines = new Set<string>();

  constructor(
    public client: SigClient = sigClient(),
    private now: () => Date = () => new Date(),
  ) {}

  status(): CollectorStatus {
    return {
      running: this.running,
      runId: this.runId,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      ticks: this.ticks,
      markets: this.markets.length,
      depthBooks: [...this.books.values()].filter((b) => !b.topOnly).length,
      paperTrading: this.paperTrading,
      strategy: this.strategy.name,
      lastError: this.lastError,
      readsLastMinute: this.client.reads.usedLastMinute(),
      readBudgetPerMinute: this.client.reads.capacity,
      rateLimited: this.client.rateLimited,
      priceIntervalSec: config.priceIntervalSec,
      headlinesSeen: [...this.headlines.values()].reduce((s, h) => s + h.length, 0),
    };
  }

  async start(opts: { paperTrading?: boolean; strategy?: Partial<StrategyConfig> } = {}) {
    if (this.running) return this.status();
    this.paperTrading = Boolean(opts.paperTrading);
    if (opts.strategy) this.strategy = mergeStrategy({ ...opts.strategy, name: opts.strategy.name ?? "live-paper" });
    this.running = true;
    this.startedAt = this.now().toISOString();
    this.ticks = 0;
    this.lastError = null;
    this.headlines = headlinesUpTo(this.startedAt);
    const r = db().prepare("INSERT INTO collector_runs(started_at, status, paper_trading) VALUES (?, 'running', ?)").run(this.startedAt, this.paperTrading ? 1 : 0);
    this.runId = Number(r.lastInsertRowid);
    kvSet("collector_desired", { running: true, paperTrading: this.paperTrading, strategy: this.strategy });
    this.unsink = addLogSink((e) => {
      if (e.level === "WARNING" || e.level === "ERROR" || e.component === "collector" || e.component === "paper") {
        const { ts, level, component, event, ...rest } = e;
        logRow(ts, level, component, event, rest);
      }
    });
    if (this.paperTrading) this.initPaper();
    log("INFO", "collector", "started", { runId: this.runId, paperTrading: this.paperTrading, readBudget: this.client.reads.capacity });
    this.loop = this.run();
    return this.status();
  }

  async stop(reason = "user") {
    if (!this.running) return this.status();
    this.running = false;
    kvSet("collector_desired", { running: false });
    await this.loop?.catch(() => undefined);
    db().prepare("UPDATE collector_runs SET stopped_at = ?, status = 'stopped', ticks = ?, reads = ?, errors = ?, note = ? WHERE id = ?")
      .run(this.now().toISOString(), this.ticks, this.client.reads.used, this.client.errors, reason, this.runId);
    if (this.paperTrading) this.savePaper();
    log("INFO", "collector", "stopped", { runId: this.runId, ticks: this.ticks, reason });
    this.unsink?.();
    this.unsink = null;
    return this.status();
  }

  private async run() {
    while (this.running) {
      const t0 = Date.now();
      try {
        await this.tick();
        this.lastError = null;
      } catch (e) {
        this.lastError = String(e);
        log("ERROR", "collector", "tick_failed", { error: String(e) });
      }
      const wait = config.priceIntervalSec * 1000 - (Date.now() - t0);
      // Sleep in small steps so stop() returns promptly.
      for (let left = wait; left > 0 && this.running; left -= 250) await sleep(Math.min(250, left));
    }
  }

  async tick() {
    const now = this.now();
    const ts = now.toISOString();
    if (!this.tournamentId) this.tournamentId = (await this.client.tournament()).id;

    if (!this.markets.length || now.getTime() - this.lastMarketsAt > config.marketsRefreshSec * 1000) {
      const raw = await this.client.listMarkets(this.tournamentId);
      this.markets = raw.filter((m) => !m.isComposite && m.exchanges.length === 1).map(toSigMarket);
      upsertMarkets(this.markets, ts);
      this.lastMarketsAt = now.getTime();
      log("INFO", "collector", "markets_refreshed", { count: this.markets.length });
    }

    // 1. Top of book for the whole universe: ceil(N / 100) reads.
    const prices = await this.client.prices(this.markets.map((m) => m.exchangeId), this.tournamentId);
    const dirty: string[] = [];
    for (const p of prices) {
      const prev = this.books.get(p.marketId);
      const next = bookFromPrice(p, prev);
      if (next !== prev) dirty.push(p.marketId);
      this.books.set(p.marketId, next);
    }

    // 2. Depth: changed books first, then the stalest. Keep a reserve for the next price poll.
    const reserve = Math.ceil(this.markets.length / 100) + 2;
    const stalest = [...this.markets]
      .map((m) => m.id)
      .filter((id) => !dirty.includes(id))
      .sort((a, b) => (this.depthFetchedAt.get(a) ?? 0) - (this.depthFetchedAt.get(b) ?? 0));
    const queue = [...dirty, ...stalest];
    let depthReads = 0;
    while (queue.length && this.client.reads.available() > reserve && depthReads < 10) {
      const id = queue.shift()!;
      try {
        const b = await this.client.orderbook(id, this.tournamentId, 50);
        if (b) {
          this.books.set(id, b);
          this.depthFetchedAt.set(id, Date.now());
        }
      } catch (e) {
        log("WARNING", "collector", "depth_failed", { marketId: id, error: String(e) });
      }
      depthReads++;
    }

    let stored = 0;
    for (const b of this.books.values()) if (storeBook(ts, b, config.snapshotHeartbeatSec)) stored++;

    // 3. External reference prices (Polymarket / Kalshi), outside the SIG budget.
    if (now.getTime() - this.lastExternalAt > config.externalIntervalSec * 1000) {
      try {
        const snap = await externalCached(this.markets, 0);
        this.external = snap.byMarket;
        storeExternal(ts, snap.byMarket);
        this.lastExternalAt = now.getTime();
      } catch (e) {
        log("WARNING", "collector", "external_failed", { error: String(e) });
      }
    }

    // 4. News rotation through the market list.
    this.newsCredit += (config.newsMarketsPerMinute * config.priceIntervalSec) / 60;
    while (this.newsCredit >= 1 && this.markets.length) {
      this.newsCredit -= 1;
      const m = this.markets[this.newsCursor++ % this.markets.length];
      try {
        const raw = await this.client.news(m.id);
        const fresh = storeNews(m.id, raw, ts);
        if (fresh.length) {
          this.headlines.set(m.id, [...(this.headlines.get(m.id) ?? []), ...fresh]);
          log("INFO", "collector", "new_headlines", { marketId: m.id, count: fresh.length, titles: fresh.map((h) => h.title).slice(0, 3) });
        }
      } catch (e) {
        log("WARNING", "collector", "news_failed", { marketId: m.id, error: String(e) });
      }
    }

    // 5. Live paper trading on the same state the backtester replays.
    if (this.paperTrading) this.paperTick(now);

    for (const [id, b] of this.books) {
      const mid = bookStats(b).mid;
      if (mid !== null) this.prevMids.set(id, mid);
    }
    this.ticks++;
    this.lastTickAt = ts;
    if (this.ticks % 12 === 1) log("INFO", "collector", "tick", { ticks: this.ticks, dirty: dirty.length, depthReads, stored, reads: this.client.reads.usedLastMinute() });
    if (this.runId) db().prepare("UPDATE collector_runs SET ticks = ?, reads = ?, errors = ? WHERE id = ?").run(this.ticks, this.client.reads.used, this.client.errors, this.runId);
  }

  initPaper() {
    const saved = kvGet<ReturnType<Portfolio["toJSON"]> | null>("paper_portfolio", null);
    this.portfolio = saved ? Portfolio.fromJSON(saved) : new Portfolio(config.initialBankroll);
    this.tradedHeadlines = new Set(kvGet<string[]>("paper_traded_headlines", []));
    this.exec = new PaperExecutionClient(this.portfolio, {
      onOrder: (o) => upsertOrder(o),
      onFill: (f) => {
        insertFill(f);
        log("INFO", "paper", "fill", { ...f });
      },
    });
  }

  private savePaper() {
    if (!this.portfolio) return;
    kvSet("paper_portfolio", this.portfolio.toJSON());
    kvSet("paper_traded_headlines", [...this.tradedHeadlines].slice(-5000));
  }

  private paperTick(now: Date) {
    if (!this.portfolio || !this.exec) return;
    const races = new Map(this.markets.map((m) => [m.id, m.race ? raceId(m.race) : m.id]));
    this.portfolio.raceOf = (id) => races.get(id) ?? id;
    const state = { now, markets: this.markets, books: this.books, external: this.external, headlines: this.headlines, prevMids: this.prevMids };
    const signals = computeSignals(state, this.strategy);
    const rules = kvGet<ScenarioRules | null>("scenario_rules", null);
    const r = runPortfolioTick({
      state,
      signals,
      cfg: this.strategy,
      portfolio: this.portfolio,
      exec: this.exec,
      sizingMode: this.strategy.sizing,
      rules,
      tradedHeadlines: this.tradedHeadlines,
      onDecision: (d) => insertDecision(d),
    });
    for (const l of r.logs) log(l.level, "paper", l.message, l.context ?? {});
    const snap = this.portfolio.snapshot(this.books, now.toISOString());
    if (this.ticks % 6 === 0) db().prepare("INSERT INTO portfolio_snapshots(ts, payload) VALUES (?, ?)").run(snap.timestamp, JSON.stringify(snap));
    this.savePaper();
  }
}

export function collector(): Collector {
  const g = globalThis as unknown as { __collector?: Collector };
  if (!g.__collector) g.__collector = new Collector();
  return g.__collector;
}
