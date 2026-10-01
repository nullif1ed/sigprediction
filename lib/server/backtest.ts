import { randomUUID } from "node:crypto";
import { db, j, kvSet, pj } from "./db";
import { loadMarkets, rowToBook } from "./store";
import { log } from "./log";
import type { ExternalQuote, NewsHeadline, SigMarket, SizingStrategyName, YesBook } from "../core/types";
import { SIZING_STRATEGIES } from "../core/types";
import { computeSignals, mergeStrategy, runPortfolioTick, type MarketState, type StrategyConfig } from "../core/engine";
import { Portfolio, valuePosition } from "../core/portfolio";
import { PaperExecutionClient } from "../core/execution";
import { computeMetrics, strategyScore, type EquityPoint, type PerformanceMetrics } from "../core/metrics";
import { bookStats } from "../core/orderbook";
import { raceId } from "../core/races";
import { selectStrategy, type ScenarioRules } from "../core/sizing";

// Event-driven backtester that replays collected snapshots in timestamp order.
// - No look-ahead: the state at time t only contains books/quotes/headlines stamped <= t.
// - Latency: when the simulated latency exceeds the gap to the next snapshot, fills use that
//   next snapshot's book instead of the one the decision was made on.
// - Every signal is sized by all three sizing strategies in parallel portfolios, plus an "auto"
//   portfolio that picks a strategy per scenario. Outcomes per scenario become the rules that
//   "auto" (and live paper trading) use next time.

export type PortfolioName = SizingStrategyName | "auto";
export const PORTFOLIOS: PortfolioName[] = [...SIZING_STRATEGIES, "auto"];

export interface BacktestRequest {
  strategy: Partial<StrategyConfig> & { name: string };
  from?: string | null;
  to?: string | null;
  replaySpeed?: number; // 0 = as fast as possible; N = N x real time
  latencyMs?: number;
  initialCapital?: number;
  basedOn?: string | null;
}

interface Running {
  stop: boolean;
}
const running = (): Map<string, Running> => {
  const g = globalThis as unknown as { __bt?: Map<string, Running> };
  g.__bt ??= new Map();
  return g.__bt;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const yieldLoop = () => new Promise((r) => setImmediate(r));

export function startBacktest(req: BacktestRequest): string {
  const id = randomUUID();
  const cfg = mergeStrategy(req.strategy);
  const startedAt = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO backtest_sessions(session_id, strategy_name, strategy_version, description, strategy_config, based_on, data_from, data_to,
         replay_speed, latency_ms, status, progress, started_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'running', 0, ?)`,
    )
    .run(id, cfg.name, startedAt, cfg.description, j(cfg), req.basedOn ?? cfg.basedOn ?? null, req.from ?? null, req.to ?? null, req.replaySpeed ?? 0, req.latencyMs ?? 0, startedAt);
  const flag = { stop: false };
  running().set(id, flag);
  runBacktest(id, cfg, req, flag)
    .catch((e) => {
      log("ERROR", "backtest", "failed", { sessionId: id, error: String(e) });
      db().prepare("UPDATE backtest_sessions SET status='failed', error=?, ended_at=? WHERE session_id=?").run(String(e), new Date().toISOString(), id);
    })
    .finally(() => running().delete(id));
  return id;
}

export function stopBacktest(id: string): boolean {
  const r = running().get(id);
  if (!r) return false;
  r.stop = true;
  return true;
}

interface Book {
  portfolio: Portfolio;
  exec: PaperExecutionClient;
  traded: Set<string>;
  curve: EquityPoint[];
  closed: { pnl: number }[];
  trades: number;
  notional: number;
  entryScenario: Map<string, { scenario: string; strategy: SizingStrategyName }>;
}

export async function runBacktest(id: string, cfg: StrategyConfig, req: BacktestRequest, flag: { stop: boolean } = { stop: false }) {
  const d = db();
  const markets: SigMarket[] = loadMarkets();
  if (!markets.length) throw new Error("No collected markets. Start data collection first.");
  const range = d.prepare("SELECT MIN(ts) a, MAX(ts) b FROM book_snapshots").get() ?? {};
  const from = req.from ?? (range.a as string | null);
  const to = req.to ?? (range.b as string | null);
  if (!from || !to) throw new Error("No collected order-book snapshots in range.");
  d.prepare("UPDATE backtest_sessions SET data_from=?, data_to=? WHERE session_id=?").run(from, to, id);

  const stamps = d.prepare("SELECT DISTINCT ts FROM book_snapshots WHERE ts >= ? AND ts <= ? ORDER BY ts").all(from, to).map((r) => String(r.ts));
  if (stamps.length < 2) throw new Error("Need at least two snapshot timestamps in the selected window.");

  const races = new Map(markets.map((m) => [m.id, m.race ? raceId(m.race) : m.id]));
  const capital = req.initialCapital ?? 100_000;
  const rules = pj<ScenarioRules | null>((d.prepare("SELECT v FROM kv WHERE k='scenario_rules'").get() ?? {}).v, null);

  const insTrade = d.prepare(
    "INSERT INTO backtest_trades(session_id, portfolio, order_id, market_id, action, quantity, price, realized_pnl, tag, sim_ts) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  const insEq = d.prepare("INSERT INTO backtest_equity(session_id, portfolio, sim_ts, equity, cash, exposure, drawdown) VALUES (?,?,?,?,?,?,?)");
  const insLog = d.prepare("INSERT INTO backtest_logs(session_id, sim_ts, level, message, context) VALUES (?,?,?,?,?)");
  let logCount = 0;
  const addLog = (simTs: string, level: string, message: string, context?: unknown) => {
    if (logCount++ < 20_000) insLog.run(id, simTs, level, message, context ? j(context) : null);
  };

  const books: Record<PortfolioName, Book> = {} as Record<PortfolioName, Book>;
  let simNow = new Date(from);
  for (const name of PORTFOLIOS) {
    const pf = new Portfolio(capital);
    pf.raceOf = (m) => races.get(m) ?? m;
    const b: Book = { portfolio: pf, exec: null as unknown as PaperExecutionClient, traded: new Set(), curve: [], closed: [], trades: 0, notional: 0, entryScenario: new Map() };
    b.exec = new PaperExecutionClient(pf, {
      onFill: (f, o) => {
        b.trades++;
        b.notional += f.quantity * f.price;
        const key = `${f.marketId}`;
        const tag = o.tag ?? "";
        const parts = tag.split(":");
        if (!tag.startsWith("exit") && parts.length >= 3) b.entryScenario.set(key, { scenario: parts[1], strategy: parts[2] as SizingStrategyName });
        if (f.realizedPnl !== 0) b.closed.push({ pnl: f.realizedPnl });
        insTrade.run(id, name, f.orderId, f.marketId, f.action, f.quantity, f.price, f.realizedPnl, tag, f.timestamp);
      },
    });
    b.exec.now = () => simNow;
    books[name] = b;
  }

  // Scenario attribution for the three fixed-strategy portfolios.
  const attribution: Record<string, Record<SizingStrategyName, { pnl: number; cost: number; trades: number }>> = {};
  const attribute = (strategy: SizingStrategyName, scenario: string, pnl: number, cost: number, trade: boolean) => {
    attribution[scenario] ??= {} as Record<SizingStrategyName, { pnl: number; cost: number; trades: number }>;
    const a = (attribution[scenario][strategy] ??= { pnl: 0, cost: 0, trades: 0 });
    a.pnl += pnl;
    a.cost += cost;
    if (trade) a.trades++;
  };

  // --- State reconstruction (strict timestamp order) ---
  const bookAt = new Map<string, YesBook>();
  for (const r of d
    .prepare("SELECT b.* FROM book_snapshots b JOIN (SELECT market_id, MAX(id) id FROM book_snapshots WHERE ts < ? GROUP BY market_id) l ON b.id = l.id")
    .all(from))
    bookAt.set(String(r.market_id), rowToBook(r));
  const extRows = d.prepare("SELECT ts, market_id, payload FROM external_quotes WHERE ts <= ? ORDER BY ts").all(to);
  let extIdx = 0;
  const extAt = new Map<string, Map<string, ExternalQuote>>();
  const headRows = d.prepare("SELECT * FROM headlines WHERE first_seen_at <= ? ORDER BY first_seen_at").all(to);
  let headIdx = 0;
  const headAt = new Map<string, NewsHeadline[]>();
  const rowsAt = d.prepare("SELECT * FROM book_snapshots WHERE ts = ?");

  const advance = (ts: string) => {
    for (const r of rowsAt.all(ts)) bookAt.set(String(r.market_id), rowToBook(r));
    while (extIdx < extRows.length && String(extRows[extIdx].ts) <= ts) {
      const r = extRows[extIdx++];
      const q = pj<ExternalQuote>(r.payload, null as unknown as ExternalQuote);
      if (!q) continue;
      const m = extAt.get(String(r.market_id)) ?? new Map();
      m.set(q.venue, q);
      extAt.set(String(r.market_id), m);
    }
    while (headIdx < headRows.length && String(headRows[headIdx].first_seen_at) <= ts) {
      const r = headRows[headIdx++];
      const h: NewsHeadline = {
        id: String(r.id), marketId: String(r.market_id), url: String(r.url ?? ""), title: String(r.title ?? ""), source: String(r.source ?? ""),
        summary: String(r.summary ?? ""), publishedDate: String(r.published_date ?? ""), relevanceExplanation: String(r.relevance ?? ""), firstSeenAt: String(r.first_seen_at),
      };
      headAt.set(h.marketId, [...(headAt.get(h.marketId) ?? []), h]);
    }
  };

  const latency = req.latencyMs ?? 0;
  const speed = req.replaySpeed ?? 0;
  const eqEvery = Math.max(1, Math.ceil(stamps.length / 1500));
  const prevMids = new Map<string, number>();
  const signalsSeen = { headline: 0, arbitrage: 0, decisions: 0, rejected: 0 };

  advance(stamps[0]);
  for (let i = 0; i < stamps.length; i++) {
    if (flag.stop) break;
    const ts = stamps[i];
    simNow = new Date(ts);
    const state: MarketState = {
      now: simNow,
      markets,
      books: new Map(bookAt),
      external: new Map([...extAt.entries()].map(([k, v]) => [k, [...v.values()]])),
      headlines: headAt,
      prevMids,
    };
    // Latency: if the next snapshot arrives before our order would, fill against it.
    let execBooks = state.books;
    const next = stamps[i + 1];
    if (next && latency > 0 && Date.parse(next) - Date.parse(ts) <= latency) {
      advance(next);
      execBooks = new Map(bookAt);
    }
    const signals = computeSignals(state, cfg);
    signalsSeen.headline += signals.headlines.length;
    signalsSeen.arbitrage += signals.arbitrage.length;

    for (const name of PORTFOLIOS) {
      const b = books[name];
      const r = runPortfolioTick({
        state,
        signals,
        cfg,
        portfolio: b.portfolio,
        exec: b.exec,
        sizingMode: name === "auto" ? "auto" : name,
        rules,
        tradedHeadlines: b.traded,
        execBooks,
      });
      if (name === "auto") {
        signalsSeen.decisions += r.decisions.length;
        signalsSeen.rejected += r.decisions.filter((x) => x.rejected).length;
        for (const l of r.logs) addLog(ts, l.level, l.message, l.context);
        for (const dcs of r.decisions) if (!dcs.rejected) addLog(ts, "INFO", `DECISION ${dcs.action} ${dcs.marketId} q=${dcs.quantity} score=${dcs.riskAdjustedScore}`, { reason: dcs.reason, scenario: dcs.scenario, sizing: dcs.sizingStrategy, netEdge: dcs.netEdge, fair: dcs.fairValue });
      }
      if (i % eqEvery === 0 || i === stamps.length - 1) {
        const snap = b.portfolio.snapshot(state.books, ts);
        b.curve.push({ t: ts, equity: snap.equity, exposure: snap.grossExposure });
        insEq.run(id, name, ts, snap.equity, snap.cash, snap.grossExposure, snap.drawdown);
      }
    }

    for (const [mid, bk] of state.books) {
      const m = bookStats(bk).mid;
      if (m !== null) prevMids.set(mid, m);
    }
    if (!(next && latency > 0 && Date.parse(next) - Date.parse(ts) <= latency) && next) advance(next);

    if (i % 25 === 0) {
      d.prepare("UPDATE backtest_sessions SET progress=?, sim_time=? WHERE session_id=?").run((i + 1) / stamps.length, ts, id);
      await yieldLoop();
    }
    if (speed > 0 && next) await sleep(Math.min(1000, (Date.parse(next) - Date.parse(ts)) / speed));
  }

  // --- Results ---
  const finalTs = simNow.toISOString();
  const finalBooks = new Map(bookAt);
  const metrics: Record<string, PerformanceMetrics & { score: number }> = {};
  for (const name of PORTFOLIOS) {
    const b = books[name];
    const m = computeMetrics({ startingCapital: capital, curve: b.curve, closedTrades: b.closed, numTrades: b.trades, tradedNotional: b.notional });
    metrics[name] = { ...m, score: strategyScore(m) };
    if (name !== "auto") {
      // Attribute realized P&L by entry scenario, plus unrealized P&L of what is still open.
      const realizedByMarket = d
        .prepare("SELECT market_id, SUM(realized_pnl) pnl, SUM(CASE WHEN tag NOT LIKE 'exit%' THEN quantity * price ELSE 0 END) cost, SUM(CASE WHEN tag NOT LIKE 'exit%' THEN 1 ELSE 0 END) n FROM backtest_trades WHERE session_id=? AND portfolio=? GROUP BY market_id")
        .all(id, name);
      for (const r of realizedByMarket) {
        const e = b.entryScenario.get(String(r.market_id));
        if (!e) continue;
        let pnl = Number(r.pnl);
        for (const p of b.portfolio.positions().filter((x) => x.marketId === String(r.market_id))) {
          const v = valuePosition(p, finalBooks.get(p.marketId));
          pnl += v.mid - p.lots.reduce((s, l) => s + l.quantity * l.price, 0);
        }
        attribute(name, e.scenario, pnl, Number(r.cost), false);
        attribution[e.scenario][name].trades += Number(r.n);
      }
    }
  }

  const scenarioRules: ScenarioRules = {};
  const scenarioAnalysis: Record<string, unknown> = {};
  for (const [scenario, byStrat] of Object.entries(attribution)) {
    const ranked = (Object.entries(byStrat) as [SizingStrategyName, { pnl: number; cost: number; trades: number }][])
      .map(([s, a]) => ({ strategy: s, ...a, returnOnCapital: a.cost > 0 ? a.pnl / a.cost : 0 }))
      .sort((x, y) => y.returnOnCapital - x.returnOnCapital);
    const best = ranked[0];
    const trades = Math.min(...ranked.map((r) => r.trades));
    scenarioRules[scenario] = { strategy: best.strategy, trades, avgPnl: trades ? best.pnl / trades : 0 };
    scenarioAnalysis[scenario] = { best: best.strategy, strategies: ranked, previousRule: selectStrategy(scenario, rules) };
  }

  const best = (Object.entries(metrics) as [string, PerformanceMetrics & { score: number }][]).sort((a, b) => b[1].score - a[1].score)[0]?.[0];
  const results = {
    window: { from, to, ticks: stamps.length, simulatedUntil: finalTs, stoppedEarly: flag.stop },
    portfolios: metrics,
    bestPortfolio: best,
    signals: signalsSeen,
    scenarioAnalysis,
    decisionTree: Object.entries(scenarioRules).map(([scenario, r]) => ({ condition: scenario, strategy: r.strategy, trades: r.trades, avgPnl: +r.avgPnl.toFixed(2) })),
  };
  const status = flag.stop ? "stopped" : "completed";
  d.prepare("UPDATE backtest_sessions SET status=?, progress=?, ended_at=?, results=?, scenario_rules=?, sim_time=? WHERE session_id=?").run(
    status, flag.stop ? stamps.indexOf(finalTs) / stamps.length : 1, new Date().toISOString(), j(results), j(scenarioRules), finalTs, id,
  );
  // Completed runs with enough evidence update the rules used by "auto" sizing.
  if (status === "completed" && Object.keys(scenarioRules).length) kvSet("scenario_rules", scenarioRules);
  log("INFO", "backtest", status, { sessionId: id, best, ticks: stamps.length });
  return results;
}

export function listSessions() {
  return db()
    .prepare("SELECT session_id, strategy_name, strategy_version, description, based_on, status, progress, data_from, data_to, started_at, ended_at, results, error FROM backtest_sessions ORDER BY started_at DESC LIMIT 200")
    .all()
    .map((r) => {
      const res = pj<{ portfolios?: Record<string, PerformanceMetrics & { score: number }>; bestPortfolio?: string } | null>(r.results, null);
      const best = res?.bestPortfolio ? res.portfolios?.[res.bestPortfolio] : undefined;
      return { ...r, results: undefined, bestPortfolio: res?.bestPortfolio ?? null, best: best ?? null, auto: res?.portfolios?.auto ?? null };
    });
}

export function sessionDetail(id: string, opts: { sinceTradeId?: number; sinceLogId?: number; logLevel?: string } = {}) {
  const d = db();
  const s = d.prepare("SELECT * FROM backtest_sessions WHERE session_id=?").get(id);
  if (!s) return null;
  const equity: Record<string, { t: string; equity: number; drawdown: number }[]> = {};
  for (const r of d.prepare("SELECT portfolio, sim_ts, equity, drawdown FROM backtest_equity WHERE session_id=? ORDER BY id").all(id)) {
    (equity[String(r.portfolio)] ??= []).push({ t: String(r.sim_ts), equity: Number(r.equity), drawdown: Number(r.drawdown) });
  }
  const trades = d.prepare("SELECT * FROM backtest_trades WHERE session_id=? AND id > ? ORDER BY id DESC LIMIT 300").all(id, opts.sinceTradeId ?? 0);
  const logs = opts.logLevel
    ? d.prepare("SELECT * FROM backtest_logs WHERE session_id=? AND id > ? AND level=? ORDER BY id DESC LIMIT 500").all(id, opts.sinceLogId ?? 0, opts.logLevel)
    : d.prepare("SELECT * FROM backtest_logs WHERE session_id=? AND id > ? ORDER BY id DESC LIMIT 500").all(id, opts.sinceLogId ?? 0);
  const counts = d.prepare("SELECT portfolio, COUNT(*) n FROM backtest_trades WHERE session_id=? GROUP BY portfolio").all(id);
  return {
    ...s,
    status: String(s.status),
    strategy_config: pj(s.strategy_config, {}),
    results: pj(s.results, null),
    scenario_rules: pj(s.scenario_rules, null),
    running: running().has(id),
    equity,
    trades,
    tradeCounts: Object.fromEntries(counts.map((c) => [c.portfolio, c.n])),
    logs: logs.map((l) => ({ ...l, context: pj(l.context, null) })),
  };
}

export function exportCsv(id: string, kind: "trades" | "logs" | "equity"): string {
  const d = db();
  const rows =
    kind === "trades"
      ? d.prepare("SELECT portfolio, sim_ts, market_id, action, quantity, price, realized_pnl, tag, order_id FROM backtest_trades WHERE session_id=? ORDER BY id").all(id)
      : kind === "logs"
        ? d.prepare("SELECT sim_ts, level, message, context FROM backtest_logs WHERE session_id=? ORDER BY id").all(id)
        : d.prepare("SELECT portfolio, sim_ts, equity, cash, exposure, drawdown FROM backtest_equity WHERE session_id=? ORDER BY id").all(id);
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
