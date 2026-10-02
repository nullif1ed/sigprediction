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
import { RealtimeBooks, type RealtimeStats } from "./realtime";
import { LiveTrader, type LiveStats } from "./liveTrader";
import { raceId, raceSampleScore } from "../core/races";
import type { ScenarioRules } from "../core/sizing";

// Data collector: polls SIG inside the published rate limit, stores order books, external
// reference quotes and news headlines, and runs the paper-trading strategy against them.
//
// Paper trading by default (a read-only SIG key is enough). With LIVE_TRADING=1 and a trade-scope
// key, the strategy's arbitrage orders are mirrored to SIG by LiveTrader.

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
  executionMode: "paper" | "live";
  realtime: RealtimeStats | null;
  live: LiveStats | null;
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
  private lastUniverseAt = 0;
  /** latest top of book per market from the bulk price feed (prices are known even when sizes are not) */
  tops = new Map<string, { bid: number | null; ask: number | null }>();
  raceMembers = new Map<string, string[]>();
  /** marketId -> epoch ms until which it stays in the hot polling set */
  hotUntil = new Map<string, number>();
  private lastDirty = new Set<string>();
  private inFlight = new Set<string>();
  private depthDone = 0;
  private workers: Promise<void>[] = [];
  rt: RealtimeBooks | null = null;
  /** markets whose realtime stream may have missed an update (refetch over REST) */
  resyncNeeded = new Set<string>();
  private rtStartedAt = 0;
  liveMode = false;
  live: LiveTrader | null = null;
  private liveReady = false;
  private liveFlush: Promise<void> | null = null;
  private lastFair = new Map<string, { p: number; confidence: number }>();
  private rtRestarts = 0;
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
      readBudgetPerMinute: this.client.reads.limit,
      rateLimited: this.client.rateLimited,
      priceIntervalSec: config.priceIntervalSec,
      headlinesSeen: [...this.headlines.values()].reduce((s, h) => s + h.length, 0),
      executionMode: this.liveMode ? "live" : "paper",
      realtime: this.rt?.stats ?? null,
      live: this.live?.stats ?? null,
    };
  }

  async start(opts: { paperTrading?: boolean; strategy?: Partial<StrategyConfig> } = {}) {
    if (this.running) return this.status();
    this.paperTrading = Boolean(opts.paperTrading);
    this.liveMode = this.paperTrading && config.liveTrading && this.client.hasKey;
    this.liveReady = false;
    if (opts.strategy) this.strategy = mergeStrategy({ ...opts.strategy, name: opts.strategy.name ?? "live-paper" });
    this.running = true;
    this.startedAt = this.now().toISOString();
    this.ticks = 0;
    this.lastError = null;
    this.headlines = headlinesUpTo(this.startedAt);
    const r = db().prepare("INSERT INTO collector_runs(started_at, status, paper_trading) VALUES (?, 'running', ?)").run(this.startedAt, this.paperTrading ? 1 : 0);
    this.runId = Number(r.lastInsertRowid);
    // Persist only the caller's overrides, so a restart after a deploy picks up new defaults.
    kvSet("collector_desired", { running: true, paperTrading: this.paperTrading, strategy: opts.strategy });
    this.unsink = addLogSink((e) => {
      if (e.level === "WARNING" || e.level === "ERROR" || e.component === "collector" || e.component === "paper") {
        const { ts, level, component, event, ...rest } = e;
        logRow(ts, level, component, event, rest);
      }
    });
    if (this.paperTrading) this.initPaper();
    log("INFO", "collector", "started", { runId: this.runId, paperTrading: this.paperTrading, live: this.liveMode, readBudget: this.client.reads.capacity });
    this.loop = this.run();
    this.workers = Array.from({ length: Math.max(1, config.depthConcurrency) }, () => this.depthWorker());
    return this.status();
  }

  async stop(reason = "user") {
    if (!this.running) return this.status();
    this.running = false;
    kvSet("collector_desired", { running: false });
    await this.loop?.catch(() => undefined);
    await Promise.all(this.workers.map((w) => w.catch(() => undefined)));
    this.workers = [];
    await this.liveFlush?.catch(() => undefined);
    await this.rt?.stop().catch(() => undefined);
    this.rt = null;
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
    // SIG is slow and flaky: cache the tournament and market list so a restart can trade at once.
    if (!this.tournamentId) {
      const cached = kvGet<string | null>("tournament_id", null);
      if (cached) this.tournamentId = cached;
      else {
        this.tournamentId = (await this.client.tournament()).id;
        kvSet("tournament_id", this.tournamentId);
      }
    }

    if (!this.markets.length || now.getTime() - this.lastMarketsAt > config.marketsRefreshSec * 1000) {
      const raw = await this.client
        .listMarkets(this.tournamentId)
        .then((r) => {
          kvSet("markets_cache", r);
          return r;
        })
        .catch((e) => {
          const cached = this.markets.length ? null : kvGet<Awaited<ReturnType<SigClient["listMarkets"]>> | null>("markets_cache", null);
          if (!this.markets.length && !cached?.length) throw e;
          log("WARNING", "collector", "markets_refresh_failed", { error: String(e), usingCache: !!cached });
          return cached;
        });
      if (raw) {
        let all = raw.filter((m) => !m.isComposite && m.exchanges.length === 1).map(toSigMarket);
        if (config.marketSamplePct < 1) {
          // Keep or drop a race's legs together (never split one leg in, the other out): sample by
          // race id, not by market id.
          const kept = new Set<string>();
          const dropped = new Set<string>();
          all = all.filter((m) => {
            if (!m.race) return true; // no race grouping possible: always keep
            const r = raceId(m.race);
            const keep = kept.has(r) || (!dropped.has(r) && raceSampleScore(r) < config.marketSamplePct);
            (keep ? kept : dropped).add(r);
            return keep;
          });
          log("WARNING", "collector", "markets_sampled", { pct: config.marketSamplePct, racesKept: kept.size, racesDropped: dropped.size, marketsKept: all.length });
        }
        this.markets = all;
        upsertMarkets(this.markets, ts);
        this.lastMarketsAt = now.getTime();
        this.raceMembers.clear();
        for (const m of this.markets) if (m.race) this.raceMembers.set(raceId(m.race), [...(this.raceMembers.get(raceId(m.race)) ?? []), m.id]);
        log("INFO", "collector", "markets_refreshed", { count: this.markets.length });
        if (config.realtime && this.workers.length && this.client.hasKey) {
          if (!this.rt)
            this.rt = new RealtimeBooks(
              this.client,
              (b) => this.onRealtimeBook(b),
              (id) => this.resyncNeeded.add(id),
            );
          this.rtStartedAt = Date.now();
          await this.rt.start(this.tournamentId, this.markets).catch((e) => log("ERROR", "realtime", "start_failed", { error: String(e) }));
        }
      } else this.lastMarketsAt = now.getTime(); // keep the current list, retry at the next refresh
    }
    // Realtime watchdog: reconnect (new token = 1 write) when the feed went silent, with backoff.
    if (this.rt && !this.rt.healthy(90_000)) {
      const backoff = Math.min(10 * 60_000, 60_000 * 2 ** Math.min(4, this.rtRestarts));
      if (Date.now() - this.rtStartedAt > Math.max(90_000, backoff)) {
        this.rtRestarts++;
        this.rtStartedAt = Date.now();
        log("WARNING", "realtime", "restarting", { restarts: this.rtRestarts, stats: this.rt.stats });
        await this.rt.start(this.tournamentId, this.markets).catch((e) => log("ERROR", "realtime", "start_failed", { error: String(e) }));
      }
    } else if (this.rt?.healthy()) this.rtRestarts = 0;

    // 1. Top of book. The whole universe every UNIVERSE_POLL_SEC (ceil(N / 100) reads); in between,
    // only the hot set (held positions, arbitrage races, live signals) in a single read, so the
    // markets we can act on are refreshed every PRICE_POLL_SEC.
    // With a healthy Realtime feed every book is pushed to us, so REST prices are only a slow
    // cross-check (a disagreement marks the market for resync instead of overwriting the book).
    const rtOk = this.rt?.healthy() ?? false;
    const hot = this.hotMarkets(now.getTime());
    const universeEvery = (rtOk ? Math.max(30, config.universeIntervalSec) : config.universeIntervalSec) * 1000;
    const universeDue = !this.books.size || now.getTime() - this.lastUniverseAt >= universeEvery;
    const pollIds = universeDue ? this.markets : rtOk ? [] : this.markets.filter((m) => hot.has(m.id)).slice(0, 100);
    const dirty: string[] = [];
    if (pollIds.length) {
      // SIG often answers 500/503 or times out: a failed price read must not abort the tick, or
      // the strategy never runs. Continue on the books we already have (depth workers keep them fresh).
      const prices = await this.client.prices(pollIds.map((m) => m.exchangeId), this.tournamentId).catch((e) => {
        log("WARNING", "collector", "prices_failed", { error: String(e), markets: pollIds.length });
        return [] as Awaited<ReturnType<SigClient["prices"]>>;
      });
      for (const p of prices) {
        this.tops.set(p.marketId, { bid: p.bestBid, ask: p.bestAsk });
        const prev = this.books.get(p.marketId);
        const rtAt = this.rt?.updatedAt.get(p.marketId) ?? 0;
        if (rtOk && prev && !prev.topOnly && Date.now() - rtAt < 120_000) {
          if ((prev.bids[0]?.price ?? null) !== p.bestBid || (prev.asks[0]?.price ?? null) !== p.bestAsk) this.resyncNeeded.add(p.marketId);
          continue;
        }
        const next = bookFromPrice(p, prev);
        if (next !== prev) dirty.push(p.marketId);
        this.books.set(p.marketId, next);
      }
    }
    if (universeDue) this.lastUniverseAt = now.getTime();

    // 2. Depth is fetched by background workers (see depthWorker) so slow reads never delay ticks.
    this.lastDirty = new Set(dirty);
    if (!this.workers.length) {
      // Driven tick by tick (tests, one-off runs): fetch a bounded batch of depth inline.
      const reserve = Math.ceil(this.markets.length / 100) + 2;
      for (let i = 0; i < 10 && this.client.reads.available() > reserve; i++) {
        const id = this.nextDepthTarget(this.now().getTime());
        if (!id) break;
        try {
          const b = await this.client.orderbook(id, this.tournamentId, 50);
          if (b) this.acceptRestBook(b);
          this.depthDone++;
        } catch (e) {
          log("WARNING", "collector", "depth_failed", { marketId: id, error: String(e) });
        }
        this.depthFetchedAt.set(id, this.now().getTime());
      }
    }
    const depthReads = this.depthDone;
    this.depthDone = 0;

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
    // Off by default (NEWS_MARKETS_PER_MIN=0): no calls to the SIG website headline feed.
    this.newsCredit += (config.newsMarketsPerMinute * config.priceIntervalSec) / 60;
    // YOLO trades arbitrage only: headlines are unused, and each slow news read delays the tick.
    if (this.paperTrading && this.strategy.yolo) this.newsCredit = 0;
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

    // 5. Strategy on the same state the backtester replays; live mode mirrors fills to SIG.
    if (this.paperTrading) {
      if (this.liveMode && !this.liveReady) await this.initLive();
      if (!this.liveMode || this.liveReady) this.paperTick(now);
      if (this.live && this.liveReady && !this.liveFlush)
        this.liveFlush = this.live.flush().finally(() => {
          this.liveFlush = null;
          this.savePaper();
        });
    }

    for (const [id, b] of this.books) {
      const mid = bookStats(b).mid;
      if (mid !== null) this.prevMids.set(id, mid);
    }
    this.ticks++;
    this.lastTickAt = ts;
    if (this.ticks % 12 === 1) log("INFO", "collector", "tick", { ticks: this.ticks, dirty: dirty.length, depthReads, stored, reads: this.client.reads.usedLastMinute() });
    if (this.runId) db().prepare("UPDATE collector_runs SET ticks = ?, reads = ?, errors = ? WHERE id = ?").run(this.ticks, this.client.reads.used, this.client.errors, this.runId);
  }

  /**
   * Next market whose depth to fetch, in priority order: legs of races whose top of book shows an
   * arbitrage spread, hot markets that changed or are stale, other changed books, then the stalest.
   */
  nextDepthTarget(nowMs: number): string | null {
    const age = (id: string) => nowMs - (this.depthFetchedAt.get(id) ?? 0);
    const ok = (id: string) => !this.inFlight.has(id);
    const hot = this.hotMarkets(nowMs);
    for (const id of this.resyncNeeded) if (ok(id) && age(id) > 1500) return id;
    const rtOk = this.rt?.healthy() ?? false;
    // Realtime keeps fetched books current: only books never fetched in full still need REST.
    if (rtOk) {
      for (const m of this.markets) if (ok(m.id) && (this.books.get(m.id)?.topOnly ?? true) && age(m.id) > 30_000) return m.id;
      return null;
    }
    for (const id of this.arbHintMarkets()) if (ok(id) && age(id) > 1500) return id;
    for (const id of this.lastDirty) if (ok(id) && hot.has(id) && age(id) > 1500) return id;
    let stalestHot: string | null = null;
    for (const id of hot) if (ok(id) && age(id) > config.hotDepthMaxAgeSec * 1000 && (!stalestHot || age(id) > age(stalestHot))) stalestHot = id;
    if (stalestHot) return stalestHot;
    for (const id of this.lastDirty) if (ok(id) && age(id) > 15_000) return id;
    let stalest: string | null = null;
    for (const m of this.markets) if (ok(m.id) && (!stalest || age(m.id) > age(stalest))) stalest = m.id;
    return stalest && age(stalest) > config.coldDepthMaxAgeSec * 1000 ? stalest : null;
  }

  /** One of DEPTH_CONCURRENCY workers: spends the read budget left after price polling on depth. */
  private async depthWorker() {
    const reserve = () => Math.ceil(Math.max(1, this.markets.length) / 100) + 2;
    while (this.running) {
      const underCap = this.client.reads.usedLastMinute() < this.client.reads.limit * config.depthBudgetPct;
      const id = this.tournamentId && this.markets.length && underCap && this.client.reads.available() > reserve() ? this.nextDepthTarget(this.now().getTime()) : null;
      if (!id) {
        await sleep(200);
        continue;
      }
      this.inFlight.add(id);
      try {
        const b = await this.client.orderbook(id, this.tournamentId!, 50);
        if (b) this.acceptRestBook(b);
        this.depthFetchedAt.set(id, this.now().getTime());
        this.depthDone++;
      } catch (e) {
        this.depthFetchedAt.set(id, this.now().getTime()); // do not hammer a failing market
        log("WARNING", "collector", "depth_failed", { marketId: id, error: String(e) });
      } finally {
        this.inFlight.delete(id);
      }
    }
  }

  private onRealtimeBook(b: YesBook) {
    this.books.set(b.marketId, b);
    this.depthFetchedAt.set(b.marketId, this.now().getTime());
    this.resyncNeeded.delete(b.marketId);
  }

  private acceptRestBook(b: YesBook) {
    if (this.rt && !this.rt.acceptRest(b.marketId, b.asOf)) return;
    this.books.set(b.marketId, b);
    this.resyncNeeded.delete(b.marketId);
  }

  /** Live mode: start from SIG's real portfolio before the first decision. */
  private async initLive() {
    if (!this.tournamentId || !this.markets.length) return;
    try {
      if (!this.live) {
        // The simulator keeps our consumed liquidity until a newer book shows that level changed,
        // so a stale book can never make the engine re-buy depth we already took for real.
        this.live = new LiveTrader(
          this.client,
          this.tournamentId,
          () => this.markets,
          () => this.portfolio,
          undefined,
          () => !this.strategy.regularTrading,
          (id) => this.exec?.book(id) ?? this.books.get(id),
          () => new Set(),
          (id) => (this.books.get(id)?.topOnly ? Number.POSITIVE_INFINITY : this.now().getTime() - (this.depthFetchedAt.get(id) ?? 0)),
        );
      }
      // Orders left by a previous process are untracked: cancel them before anything else.
      try {
        const r = await this.client.cancelAll(this.tournamentId);
        log("WARNING", "live", "orphan_orders_cancelled", { cancelled: r.cancelled });
      } catch (e) {
        log("ERROR", "live", "orphan_cancel_failed", { error: String(e) });
        return;
      }
      await this.live.reconcile(true);
      this.live.aggressive = this.strategy.yolo;
      this.liveReady = true;
      log("WARNING", "live", "live_trading_started", { accountValue: this.live.stats.accountValue, positions: this.portfolio?.positions().length ?? 0 });
    } catch (e) {
      log("ERROR", "live", "initial_reconcile_failed", { error: String(e) });
    }
  }

  private get pfKey() {
    return this.liveMode ? "live_portfolio" : "paper_portfolio";
  }

  /** Markets worth refreshing every fast tick. */
  hotMarkets(nowMs: number): Set<string> {
    const hot = new Set<string>();
    for (const p of this.portfolio?.positions() ?? []) hot.add(p.marketId);
    for (const [id, until] of this.hotUntil) {
      if (until > nowMs) hot.add(id);
      else this.hotUntil.delete(id);
    }
    for (const id of this.arbHintMarkets()) hot.add(id);
    // A race is hot as a unit: arbitrage and complement pricing need every leg fresh.
    for (const id of [...hot]) {
      const m = this.markets.find((x) => x.id === id);
      if (m?.race) for (const peer of this.raceMembers.get(raceId(m.race)) ?? []) hot.add(peer);
    }
    return hot;
  }

  /** Legs of races whose top-of-book YES bids sum to >= 1 (or asks to <= 1): depth decides the size. */
  arbHintMarkets(): string[] {
    const out: string[] = [];
    for (const ids of this.raceMembers.values()) {
      if (ids.length < 2) continue;
      const t = ids.map((id) => this.tops.get(id));
      if (t.some((x) => !x)) continue;
      const bids = t.map((x) => x!.bid);
      const asks = t.map((x) => x!.ask);
      const sumBid = bids.every((b) => b !== null) ? bids.reduce((a, b) => a + b!, 0) : 0;
      const sumAsk = asks.every((x) => x !== null) ? asks.reduce((a, b) => a + b!, 0) : 2;
      if (sumBid >= 1 - 1e-9 || sumAsk <= 1 + 1e-9) out.push(...ids);
    }
    return out;
  }

  initPaper() {
    const saved = kvGet<ReturnType<Portfolio["toJSON"]> | null>(this.pfKey, null);
    this.portfolio = saved ? Portfolio.fromJSON(saved) : new Portfolio(config.initialBankroll);
    this.tradedHeadlines = new Set(kvGet<string[]>("paper_traded_headlines", []));
    this.exec = new PaperExecutionClient(this.portfolio, {
      onOrder: (o) => {
        upsertOrder(o);
        this.live?.capture(o);
      },
      onFill: (f) => {
        insertFill(f);
        log("INFO", "paper", "fill", { ...f });
      },
    });
  }

  private savePaper() {
    if (!this.portfolio) return;
    kvSet(this.pfKey, this.portfolio.toJSON());
    kvSet("paper_traded_headlines", [...this.tradedHeadlines].slice(-5000));
  }

  private paperTick(now: Date) {
    if (!this.portfolio || !this.exec) return;
    const races = new Map(this.markets.map((m) => [m.id, m.race ? raceId(m.race) : m.id]));
    this.portfolio.raceOf = (id) => races.get(id) ?? id;
    // Live: decide only on full-depth books that are not waiting for a resync.
    const books = this.liveMode ? new Map([...this.books].filter(([id, b]) => !b.topOnly && !this.resyncNeeded.has(id))) : this.books;
    const state = { now, markets: this.markets, books, external: this.external, headlines: this.headlines, prevMids: this.prevMids };
    const signals = computeSignals(state, this.strategy);
    for (const [id, f] of signals.fair) this.lastFair.set(id, { p: f.fairProbability, confidence: f.confidence });
    // Keep the markets the strategy is looking at in the fast polling set for a minute.
    const until = now.getTime() + 60_000;
    for (const a of signals.arbitrage) for (const l of a.legs) this.hotUntil.set(l.marketId, until);
    for (const h of signals.headlines) this.hotUntil.set(h.marketId, until);
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
