import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb, setDb, db, kvGet } from "@/lib/server/db";
import { SigClient } from "@/lib/server/sigClient";
import { Collector } from "@/lib/server/collector";
import { resetStoreCache, dataRange, latestBooks } from "@/lib/server/store";
import { runBacktest, sessionDetail, startBacktest, PORTFOLIOS } from "@/lib/server/backtest";
import { mergeStrategy } from "@/lib/core/engine";
import { fixture } from "./helpers";

// End-to-end with mocked SIG / Polymarket / Kalshi responses: collect -> paper trade -> backtest.

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
let tick = 0;
// NH Senate Dem YES book drifts down below fair (~0.86 from external) then recovers.
const nhAsk = [0.905, 0.9, 0.8, 0.8, 0.82, 0.85, 0.9, 0.92, 0.93, 0.93];
const nhBid = [0.825, 0.82, 0.76, 0.76, 0.78, 0.83, 0.88, 0.9, 0.91, 0.91];

function sigFetch(url: string): Response {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith("/tournaments/midterm-elections")) return json(fixture("sig-tournament.json"));
  if (p.endsWith("/api/v1/markets")) return json(fixture("sig-markets.json"));
  if (p.endsWith("/exchanges/prices")) {
    const base = fixture<{ data: { marketId: string; bestBid: number | null; bestAsk: number | null }[] }>("sig-prices.json");
    const i = Math.min(tick, nhAsk.length - 1);
    return json({ data: base.data.map((x) => (x.marketId === "381" ? { ...x, bestBid: nhBid[i], bestAsk: nhAsk[i] } : x)), missingIds: [] });
  }
  const ob = /\/api\/v1\/markets\/(\d+)\/orderbook/.exec(p);
  if (ob) {
    const id = ob[1];
    const base = fixture<{ data: { marketId: string; exchangeId: string; bestBid: number | null; bestAsk: number | null }[] }>("sig-prices.json").data.find((x) => x.marketId === id)!;
    const i = Math.min(tick, nhAsk.length - 1);
    const bid = id === "381" ? nhBid[i] : base.bestBid;
    const ask = id === "381" ? nhAsk[i] : base.bestAsk;
    return json({
      exchanges: [{ exchangeId: base.exchangeId, asOf: { sequence: 1000 + tick, at: new Date(Date.UTC(2026, 9, 1, 16, 0, tick * 5)).toISOString() }, bids: bid !== null ? [{ price: bid, quantity: 800 }, { price: +(bid - 0.01).toFixed(3), quantity: 2000 }] : [], asks: ask !== null ? [{ price: ask, quantity: 800 }, { price: +(ask + 0.01).toFixed(3), quantity: 2000 }] : [] }],
    });
  }
  const news = /\/api\/markets\/(\d+)\/news/.exec(p);
  if (news) return json(news[1] === "381" ? fixture("sig-news-381.json") : news[1] === "382" ? fixture("sig-news-382.json") : { contextSummary: null, headlines: [], lastRefresh: null });
  return json({ error: { code: "NOT_FOUND", message: p } }, 404);
}

function externalFetch(url: string): Response {
  if (url.includes("gamma-api.polymarket.com")) return json([fixture("polymarket-nh-senate.json")]);
  if (url.includes("/events/SENATENH-26")) return json(fixture("kalshi-senatenh-26.json"));
  return json({ error: { code: "not_found" } }, 404);
}

describe("collector -> paper trading -> backtest (mock API)", () => {
  let now = Date.UTC(2026, 9, 1, 16, 0, 0);
  beforeAll(() => {
    setDb(openDb(":memory:"));
    resetStoreCache();
    vi.stubGlobal("fetch", async (u: string | URL) => externalFetch(String(u)));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    setDb(null);
  });

  it("collects snapshots, external quotes and news, and paper trades within limits", async () => {
    const client = new SigClient({ apiKey: "k", baseUrl: "https://sig.test/api/v1", siteUrl: "https://sig.test", fetchFn: (async (u: string) => sigFetch(u)) as unknown as typeof fetch, sleep: async () => {}, readsPerMinute: 10_000 });
    const c = new Collector(client, () => new Date(now));
    c.paperTrading = true;
    c.strategy = mergeStrategy({ name: "it", regularTrading: true });
    c.initPaper();
    for (tick = 0; tick < nhAsk.length; tick++) {
      await c.tick();
      now += 5000;
    }
    const range = dataRange();
    expect(range.snapshots).toBeGreaterThan(nhAsk.length);
    expect(range.markets).toBe(13);
    expect(Number(db().prepare("SELECT COUNT(*) n FROM external_quotes").get()!.n)).toBeGreaterThan(0);
    expect(Number(db().prepare("SELECT COUNT(*) n FROM headlines").get()!.n)).toBeGreaterThan(0);
    // First-fetch headlines are backdated so they do not trigger headline trades.
    const fresh = db().prepare("SELECT COUNT(*) n FROM headlines WHERE first_seen_at >= '2026-10-01T16:00:00'").get()!.n;
    expect(Number(fresh)).toBe(0);
    expect(latestBooks().get("381")!.asks[0].price).toBeCloseTo(0.93);

    const orders = db().prepare("SELECT * FROM paper_orders ORDER BY created_at").all();
    const buys = orders.filter((o) => o.market_id === "381" && o.action === "BUY_YES" && Number(o.filled_quantity) > 0);
    expect(buys.length).toBeGreaterThan(0);
    const exits = orders.filter((o) => String(o.tag ?? "").startsWith("exit"));
    expect(exits.length).toBeGreaterThan(0);
    const pf = kvGet<{ cash: number; realizedPnl: number } | null>("paper_portfolio", null)!;
    expect(pf.realizedPnl).toBeGreaterThan(0);
    expect(pf.cash).toBeGreaterThan(0);
    const decisions = db().prepare("SELECT payload FROM decisions").all().map((r) => JSON.parse(String(r.payload)));
    for (const d of decisions.filter((x) => !x.rejected)) expect(d.estimatedCost).toBeLessThanOrEqual(100_000 * 0.05 + 1);
  });

  it("replays the collected data with all sizing strategies and learns scenario rules", async () => {
    const id = "it-session";
    const cfg = mergeStrategy({ name: "it-bt", description: "integration" });
    db().prepare("INSERT INTO backtest_sessions(session_id, strategy_name, strategy_version, strategy_config, status, started_at) VALUES (?,?,?,?, 'running', ?)").run(id, cfg.name, "v", JSON.stringify(cfg), new Date().toISOString());
    const res = await runBacktest(id, cfg, { strategy: cfg, latencyMs: 0 });
    expect(Object.keys(res.portfolios).sort()).toEqual([...PORTFOLIOS].sort());
    expect(res.window.ticks).toBeGreaterThan(5);
    for (const m of Object.values(res.portfolios)) {
      expect(m.startingCapital).toBe(100_000);
      expect(m.maxDrawdown).toBeLessThan(0.2);
    }
    expect(res.portfolios.fixed_fractional.numTrades).toBeGreaterThan(0);
    expect(Object.keys(res.scenarioAnalysis).length).toBeGreaterThan(0);
    expect(kvGet("scenario_rules", null)).not.toBeNull();
    const d = sessionDetail(id)!;
    expect(d.status).toBe("completed");
    expect(Object.keys(d.equity)).toHaveLength(4);
    expect(d.trades.length).toBeGreaterThan(0);
    expect(d.logs.length).toBeGreaterThan(0);
  });

  it("runs asynchronously and can be stopped", async () => {
    const id = startBacktest({ strategy: { name: "async" }, replaySpeed: 1 });
    await new Promise((r) => setTimeout(r, 50));
    const { stopBacktest } = await import("@/lib/server/backtest");
    expect(stopBacktest(id)).toBe(true);
    for (let i = 0; i < 100 && sessionDetail(id)!.running; i++) await new Promise((r) => setTimeout(r, 50));
    expect(["stopped", "completed"]).toContain(sessionDetail(id)!.status);
  });
});

describe("collector polling priorities", () => {
  it("flags every leg of a race whose top-of-book YES bids sum to 1 or more", () => {
    const c = new Collector(new SigClient({ apiKey: "k", fetchFn: (async () => new Response("{}")) as unknown as typeof fetch }));
    c.raceMembers.set("2026:SENATE:NH", ["381", "382"]);
    c.raceMembers.set("2026:SENATE:DE", ["353", "386"]);
    c.tops.set("381", { bid: 0.14, ask: 0.145 });
    c.tops.set("382", { bid: 0.865, ask: 0.87 });
    c.tops.set("353", { bid: 0.05, ask: 0.06 });
    c.tops.set("386", { bid: 0.9, ask: 0.95 });
    expect(c.arbHintMarkets().sort()).toEqual(["381", "382"]);
    expect([...c.hotMarkets(Date.now())].sort()).toEqual(["381", "382"]);
  });
});
