import { describe, expect, it } from "vitest";
import { LiveTrader } from "@/lib/server/liveTrader";
import { SigClient } from "@/lib/server/sigClient";
import { RealtimeBooks } from "@/lib/server/realtime";
import { Portfolio } from "@/lib/core/portfolio";
import { PaperExecutionClient } from "@/lib/core/execution";
import { computeSignals, mergeStrategy, runPortfolioTick, type MarketState } from "@/lib/core/engine";
import { parseSigTitle } from "@/lib/core/races";
import type { PaperOrder, SigMarket, YesBook } from "@/lib/core/types";
import { book } from "./helpers";

const mk = (id: string, ex: string, title: string): SigMarket => ({ id, exchangeId: ex, title, status: "open", settlementDate: "2026-11-04T17:00:00Z", categories: [], race: parseSigTitle(title), latestPrice: null });
const markets = [mk("381", "1070", "Will the Democratic Party win the New Hampshire Senate?"), mk("382", "1071", "Will the Republican Party win the New Hampshire Senate?")];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** Minimal fake SIG: records orders, fills a configurable fraction, serves positions. */
function fakeSig(fill: (leg: { exchangeId: string; quantity: number; price: number }) => number) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const held = new Map<string, number>(); // exchangeId -> signed qty (+YES, -NO)
  let cash = 100_000;
  const fetchFn = async (url: string, init?: { method?: string; body?: string }) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const place = (leg: { exchangeId: string; side: string; action: string; quantity: number; price: number }) => {
      const q = Math.min(leg.quantity, fill(leg));
      const sign = (leg.side === "yes" ? 1 : -1) * (leg.action === "buy" ? 1 : -1);
      held.set(leg.exchangeId, (held.get(leg.exchangeId) ?? 0) + sign * q);
      cash += (leg.action === "buy" ? -1 : 1) * q * leg.price;
      return { orderId: calls.length, exchangeId: leg.exchangeId, open: q < leg.quantity, remainingQuantity: leg.quantity - q, quantityTraded: q, totalCost: q * leg.price, fillPrice: q ? leg.price : null };
    };
    if (path === "/orders/multi-leg") return json({ results: body.legs.map((l: never, index: number) => ({ index, data: place(l) })) });
    if (path === "/orders") return json(place(body));
    if (path === "/orders/cancel-all") return json({ cancelled: 1 });
    if (init?.method === "DELETE" && path.startsWith("/orders/")) return json({ orderId: 1, message: "cancelled" });
    if (path.endsWith("/portfolio/positions"))
      return json({ positions: [...held].filter(([, q]) => q !== 0).map(([exchangeId, q]) => ({ exchangeId, marketId: exchangeId === "1070" ? "381" : "382", marketTitle: "", settled: false, quantity: q, avgCost: 0.5, currentPrice: 0.9, marketValue: Math.abs(q) * 0.1, costBasis: 0, lots: [] })), summary: {} });
    if (path.endsWith("/portfolio/pnl")) {
      const holdings = [...held.values()].reduce((s, q) => s + Math.abs(q) * 0.5, 0);
      return json({ totalAccountValue: cash + holdings, totalHoldingsValue: holdings, totalCostBasis: 0, unrealizedPnl: 0, roi: 0 });
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  };
  const client = new SigClient({ apiKey: "k", baseUrl: "https://sig.test/api/v1", fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} });
  return { client, calls, held };
}

const state = (books: Map<string, YesBook>): MarketState => ({ now: new Date("2026-10-02T16:00:00Z"), markets, books, external: new Map(), headlines: new Map() });

function setup(fill: (leg: { exchangeId: string; quantity: number; price: number }) => number) {
  const sig = fakeSig(fill);
  const pf = new Portfolio(100_000);
  const ref: { ex?: PaperExecutionClient } = {};
  const live = new LiveTrader(sig.client, "t1", () => markets, () => pf, undefined, () => true, (id) => ref.ex?.book(id));
  const ex = new PaperExecutionClient(pf, { onOrder: (o: PaperOrder) => live.capture(o) });
  ref.ex = ex;
  const cfg = mergeStrategy({ yolo: false, name: "t" });
  const tick = (books: Map<string, YesBook>) => runPortfolioTick({ state: state(books), signals: computeSignals(state(books), cfg), cfg, portfolio: pf, exec: ex, sizingMode: "fixed_fractional", rules: null, tradedHeadlines: new Set() });
  return { ...sig, pf, live, tick };
}

// YES bids 0.60 + 0.45 = 1.05: buying NO on both costs 0.95 per set and pays 1.
const arbBooks = () => new Map([["381", book("381", [[0.6, 500]], [[0.62, 500]])], ["382", book("382", [[0.45, 500]], [[0.47, 500]])]]);

describe("live execution", () => {
  it("enters a set one leg at a time: each next leg sized to what filled, with a set-profitable limit", async () => {
    const t = setup((l) => l.quantity);
    await t.live.reconcile(true);
    t.tick(arbBooks());
    await t.live.flush();
    const legs = t.calls.filter((c) => c.path === "/orders").map((c) => c.body as { exchangeId: string; side: string; action: string; quantity: number; price: number });
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.side === "no" && l.action === "buy" && l.quantity === 500)).toBe(true);
    // Second leg limit: payout 1 - first leg price paid - 0.1pp, on the 0.005 tick.
    // The fake fills at the limit: the second leg's cap is 1 - (first price paid) - 0.1pp, on tick.
    expect(legs[1].price).toBeCloseTo(Math.floor((1 - legs[0].price - 0.001) / 0.005) * 0.005, 6);
    expect(t.pf.holdings("381").NO).toBe(500);
    expect(t.pf.arbQty("382", "NO")).toBe(500);
  });

  it("TX-15 case: a partial first leg shrinks the second leg to match", async () => {
    // Bottleneck leg 1071 only fills 124 of 500: the other leg must buy 124, not 500.
    const t = setup((l) => (l.exchangeId === "1071" ? 124 : l.quantity));
    await t.live.reconcile(true);
    const thin = new Map([["381", book("381", [[0.6, 5000]], [[0.62, 500]])], ["382", book("382", [[0.45, 500]], [[0.47, 500]])]]);
    t.tick(thin);
    await t.live.flush();
    const legs = t.calls.filter((c) => c.path === "/orders").map((c) => c.body as { exchangeId: string; quantity: number });
    expect(legs[0].exchangeId).toBe("1071"); // least depth relative to size goes first
    expect(legs[1]).toMatchObject({ exchangeId: "1070", quantity: 124 });
    expect(Math.abs(t.held.get("1070")!)).toBe(124);
    expect(Math.abs(t.held.get("1071")!)).toBe(124);
  });

  it("never sells more than is really held (an unbacked sell would become a buy)", async () => {
    const t = setup((l) => l.quantity);
    await t.live.reconcile(true);
    // Paper believes it holds 1000 NO on 381 that SIG never filled.
    t.pf.applyFill("381", "BUY_NO", 1000, 0.4, "2026-10-02T16:00:00Z");
    const o = { orderId: "x", marketId: "381", action: "SELL_NO", contract: "NO", orderType: "market", limitPrice: 0.39, requestedQuantity: 1000, filledQuantity: 1000, fillPrice: 0.39, fees: 0, status: "filled", createdAt: "", updatedAt: "", expiresAt: null, notes: "", tag: "exit:profit_target", worstPrice: 0.39 } as PaperOrder;
    t.live.capture(o);
    await t.live.flush();
    expect(t.calls.filter((c) => c.path === "/orders")).toHaveLength(0);
    expect(t.pf.holdings("381").NO).toBe(0); // reconcile removed the phantom position
  });

  it("unwinds the ENTIRE set as one request when it can be sold back at a profit", async () => {
    const t = setup((l) => l.quantity);
    await t.live.reconcile(true);
    t.tick(arbBooks());
    await t.live.flush();
    // YES asks now 0.60 + 0.40 = 1.00: selling both NO legs returns 0.40 + 0.60 = 1.00 > 0.95 cost.
    t.tick(new Map([["381", book("381", [[0.59, 5000]], [[0.6, 5000]])], ["382", book("382", [[0.39, 5000]], [[0.4, 5000]])]]));
    await t.live.flush();
    const ml = t.calls.filter((c) => c.path === "/orders/multi-leg");
    const unwind = ml[0].body!.legs as { action: string; quantity: number }[];
    expect(unwind.map((l) => [l.action, l.quantity])).toEqual([["sell", 500], ["sell", 500]]);
    expect(t.pf.holdings("381").NO).toBe(0);
    expect(t.pf.holdings("382").NO).toBe(0);
  });

  it("halts new entries after the drawdown limit but keeps exits", async () => {
    const t = setup((l) => l.quantity);
    await t.live.reconcile(true);
    t.live.stats.startValue = 200_000; // pretend we started far higher
    await t.live.reconcile();
    expect(t.live.stats.halted).toMatch(/below start/);
    t.tick(arbBooks());
    await t.live.flush();
    expect(t.calls.filter((c) => c.path === "/orders/multi-leg")).toHaveLength(0);
  });
});

describe("realtime books", () => {
  it("applies versioned books, ignores older versions and flags revision gaps", () => {
    const got: YesBook[] = [];
    const resync: string[] = [];
    const rt = new RealtimeBooks({} as SigClient, (b) => got.push(b), (id) => resync.push(id));
    const batch = (rev: number, prev: number, seq: number, bid: number) => ({
      delivery: { revision: rev, previousRevision: prev },
      books: [{ exchangeId: 1070, asOf: { at: "2026-10-02T00:00:00Z", sequence: seq }, bids: [{ price: bid, quantity: 10 }], asks: [{ price: 0.9, quantity: 10 }] }],
    });
    const on = (p: unknown) => (rt as unknown as { onBatch: (m: string, e: string, p: unknown) => void }).onBatch("381", "1070", p);
    on(batch(5, 4, 100, 0.8));
    on(batch(6, 5, 99, 0.7)); // older engine version: ignored
    on(batch(9, 7, 101, 0.81)); // revisions 7..8 missed
    expect(got.map((b) => b.bids[0].price)).toEqual([0.8, 0.81]);
    expect(resync).toEqual(["381"]);
  });
});

describe("no duplicate entries", () => {
  it("does not re-buy a set while the book has not refreshed since our own fill", async () => {
    const t = setup((l) => l.quantity);
    await t.live.reconcile(true);
    t.tick(arbBooks());
    await t.live.flush();
    t.tick(arbBooks()); // same (stale) book after the reconcile
    await t.live.flush();
    expect(t.calls.filter((c) => c.path === "/orders")).toHaveLength(2);
    expect(t.pf.holdings("381").NO).toBe(500);
  });
});

describe("reconcile", () => {
  it("recognises a set held on SIG as arbitrage and locks every share so repair can balance it", async () => {
    const t = setup((l) => l.quantity);
    t.held.set("1070", -300);
    t.held.set("1071", -420);
    await t.live.reconcile(true);
    expect(t.pf.arbQty("381", "NO")).toBe(300);
    expect(t.pf.arbQty("382", "NO")).toBe(420);
    expect(t.pf.arbSets.get("2026:SENATE:NH")).toEqual(["381", "382"]);
    // Secured = cash + 300 complete sets x 1 + 120 excess NO at SIG's per-share value (0.10, not
    // the 0.90 YES price).
    expect(t.live.stats.securedValue).toBeCloseTo((t.live.stats.cash ?? 0) + 300 + 120 * 0.1, 2);
  });
});

describe("leg repair economics (Oklahoma Senate, 2 Oct)", () => {
  it("buys the short leg when that is worth more than dumping the long leg below cost", () => {
    // Held: 2511 NO on D (avg 0.943) vs 2350 NO on R (avg 0.05). 161 extra D-NO shares.
    const pf = new Portfolio(100_000);
    pf.applyFill("381", "BUY_NO", 2511, 0.943, "t", { tradeType: "arbitrage" });
    pf.applyFill("382", "BUY_NO", 2350, 0.05, "t", { tradeType: "arbitrage" });
    pf.markArb("381", "NO", 2511, 2511 * 0.943);
    pf.markArb("382", "NO", 2350, 2350 * 0.05);
    pf.arbSets.set("2026:SENATE:NH", ["381", "382"]);
    const ex = new PaperExecutionClient(pf);
    // R YES bid 0.94 -> R NO costs 0.06; D YES ask 0.07 -> selling D NO gets 0.93, 2pp limit.
    // Complete: pay 161 x 0.06 = 9.66 for 161 sets paying 161 -> worth 151.34.
    // Trim: sell 161 D-NO at ~0.93 -> 149.73. Completing wins.
    const books = new Map([["381", book("381", [[0.05, 5000]], [[0.07, 5000]])], ["382", book("382", [[0.94, 5000]], [[0.95, 5000]])]]);
    const s: MarketState = { now: new Date("2026-10-02T16:00:00Z"), markets, books, external: new Map(), headlines: new Map() };
    const cfg = mergeStrategy({ yolo: false, name: "t", arbitrage: false });
    const r = runPortfolioTick({ state: s, signals: computeSignals(s, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "fixed_fractional", rules: null, tradedHeadlines: new Set() });
    expect(r.logs.some((l) => /bought short legs up to 2511/.test(l.message))).toBe(true);
    expect(pf.holdings("381").NO).toBe(2511);
    expect(pf.holdings("382").NO).toBe(2511);
  });
});

describe("live position hygiene (2 Oct account)", () => {
  it("adopts a lone leg whose partner never filled, and repair then completes or sells it", async () => {
    const sig = fakeSig((l) => l.quantity);
    const pf = new Portfolio(100_000);
    const live = new LiveTrader(sig.client, "t1", () => markets, () => pf, undefined, () => true);
    sig.held.set("1070", -574); // NO on 381 only
    await live.reconcile(true);
    expect(pf.arbSets.get("2026:SENATE:NH")).toEqual(["381", "382"]);
    expect(pf.arbQty("381", "NO")).toBe(574);
    const ex = new PaperExecutionClient(pf);
    const cfg = mergeStrategy({ yolo: false, name: "t", arbitrage: false });
    // R YES bid 0.95 -> buying R NO costs 0.05: completing 574 sets pays 574 for 28.70 -> do it.
    const books = new Map([["381", book("381", [[0.04, 5000]], [[0.05, 5000]])], ["382", book("382", [[0.95, 5000]], [[0.96, 5000]])]]);
    const st: MarketState = { now: new Date("2026-10-02T16:00:00Z"), markets, books, external: new Map(), headlines: new Map() };
    const r = runPortfolioTick({ state: st, signals: computeSignals(st, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "fixed_fractional", rules: null, tradedHeadlines: new Set() });
    expect(r.logs.some((l) => /bought short legs up to 574 sets/.test(l.message))).toBe(true);
    // The completed set is then worth more sold back (0.99) than its cost: it is unwound at once.
    expect(r.exits.filter((e) => e.reason === "arb_unwind")).toHaveLength(2);
  });

  it("sells a set whose sale beats its payout, even if it was bought above the payout", () => {
    const pf = new Portfolio(100_000);
    pf.applyFill("381", "BUY_NO", 148, 0.6, "t", { tradeType: "arbitrage" });
    pf.applyFill("382", "BUY_NO", 148, 0.46, "t", { tradeType: "arbitrage" });
    pf.markArb("381", "NO", 148, 148 * 0.6);
    pf.markArb("382", "NO", 148, 148 * 0.46);
    pf.arbSets.set("2026:SENATE:NH", ["381", "382"]);
    const ex = new PaperExecutionClient(pf);
    const cfg = mergeStrategy({ yolo: false, name: "t", arbitrage: false });
    // Selling both NO legs returns (1-0.42) + (1-0.525) = 1.055 > payout 1 (but < cost 1.06).
    const books = new Map([["381", book("381", [[0.41, 5000]], [[0.42, 5000]])], ["382", book("382", [[0.52, 5000]], [[0.525, 5000]])]]);
    const st: MarketState = { now: new Date("2026-10-02T16:00:00Z"), markets, books, external: new Map(), headlines: new Map() };
    const r = runPortfolioTick({ state: st, signals: computeSignals(st, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "fixed_fractional", rules: null, tradedHeadlines: new Set() });
    expect(r.exits.filter((e) => e.reason === "arb_unwind")).toHaveLength(2);
    expect(pf.holdings("381").NO).toBe(0);
  });
});

describe("no accumulation into unbalanced sets", () => {
  it("does not add a new clip to a race whose legs are unequal", async () => {
    const t = setup((l) => l.quantity);
    await t.live.reconcile(true);
    t.tick(arbBooks());
    await t.live.flush();
    t.held.set("1070", -500);
    t.held.set("1071", -200);
    await t.live.reconcile(); // 500 vs 200
    const before = t.calls.filter((c) => c.path === "/orders/multi-leg").length;
    // Fresh book with the same spread: the engine must repair, not open another set.
    const r = t.tick(new Map([["381", book("381", [[0.6, 9000]], [[0.62, 500]])], ["382", book("382", [[0.45, 9000]], [[0.47, 500]])]]));
    expect(r.decisions.filter((d) => d.opportunityType === "arbitrage" && d.marketId === "381")).toHaveLength(0);
    expect(r.logs.some((l) => /ARB repair/.test(l.message))).toBe(true);
    void before;
  });
});

describe("repair orders never overshoot", () => {
  it("clips stacked repairs to the real imbalance", async () => {
    const t = setup((l) => l.quantity);
    t.held.set("1070", -1000);
    t.held.set("1071", -700);
    await t.live.reconcile(true);
    const rep = (q: number, n: number) => ({ orderId: `r${n}`, marketId: "382", action: "BUY_NO", contract: "NO", orderType: "market", limitPrice: 0.55, requestedQuantity: q, filledQuantity: q, fillPrice: 0.55, fees: 0, status: "filled", createdAt: "", updatedAt: "", expiresAt: null, notes: "", tag: "arbitrage:repair:complete", group: `repair:${n}`, worstPrice: 0.55 }) as PaperOrder;
    t.live.capture(rep(300, 1));
    t.live.capture(rep(300, 2)); // same repair decided again on the next tick
    t.live.capture(rep(900, 3)); // and an oversized one
    await t.live.flush();
    expect(Math.abs(t.held.get("1071")!)).toBe(1000);
  });
});

describe("incomplete and mixed races (NE Senate, 2 Oct)", () => {
  const NE = [mk("279", "2001", "Will the Democratic Party win the Nebraska Senate?"), mk("280", "2002", "Will the Republican Party win the Nebraska Senate?"), mk("281", "2003", "Will the Independent Party win the Nebraska Senate?")];
  it("never arbitrages a race with a missing book", () => {
    // YES asks 0.08 + 0.30 = 0.38 on two of three outcomes looks like 'buy all YES' if 281 is missing.
    const books = new Map([["279", book("279", [[0.07, 5000]], [[0.08, 5000]])], ["280", book("280", [[0.29, 5000]], [[0.3, 5000]])]]);
    const st: MarketState = { now: new Date("2026-10-02T16:00:00Z"), markets: NE, books, external: new Map(), headlines: new Map() };
    const cfg = mergeStrategy({ yolo: false, name: "t" });
    expect(computeSignals(st, cfg).arbitrage).toHaveLength(0);
    const pf = new Portfolio(100_000);
    const r = runPortfolioTick({ state: st, signals: computeSignals(st, cfg), cfg, portfolio: pf, exec: new PaperExecutionClient(pf), sizingMode: "fixed_fractional", rules: null, tradedHeadlines: new Set() });
    expect(r.decisions).toHaveLength(0);
  });

  it("does not buy a leg's contract against locked opposite holdings, nor adopt a mixed race", async () => {
    const sig = fakeSig((l) => l.quantity);
    const pf = new Portfolio(100_000);
    const ms = [...markets, ...NE];
    const live = new LiveTrader(sig.client, "t1", () => ms, () => pf, undefined, () => true);
    sig.held.set("2001", 9389); // YES
    sig.held.set("2002", 9389); // YES
    sig.held.set("2003", -4878); // NO
    await live.reconcile(true);
    expect(pf.arbSets.has("2026:SENATE:NE")).toBe(false);
    expect(pf.arbQty("281", "NO")).toBe(0);
  });
});

describe("first leg limit", () => {
  it("lets the bottleneck leg pay up to half the planned profit more, never past break-even", async () => {
    const t = setup((l) => l.quantity);
    await t.live.reconcile(true);
    // Planned 0.40 + 0.55 = 0.95: 5pp profit. First leg may pay up to +2.4pp (on tick: +2.0pp).
    t.tick(arbBooks());
    await t.live.flush();
    const legs = t.calls.filter((c) => c.path === "/orders").map((c) => c.body as { exchangeId: string; price: number });
    const planned = legs[0].exchangeId === "1070" ? 0.4 : 0.55;
    expect(legs[0].price).toBeGreaterThan(planned);
    expect(legs[0].price).toBeLessThanOrEqual(planned + 0.024 + 1e-9);
    expect(legs[0].price + legs[1].price).toBeLessThan(1);
  });
});

describe("YES positions are never completed into a set (MT Senate, 2 Oct)", () => {
  it("drops stale YES locks on reconcile and does not buy the missing YES leg", async () => {
    const sig = fakeSig((l) => l.quantity);
    const pf = new Portfolio(100_000);
    const live = new LiveTrader(sig.client, "t1", () => markets, () => pf, undefined, () => true);
    sig.held.set("1070", 862); // YES on 381 only, locked by an older version as a "YES set"
    pf.applyFill("381", "BUY_YES", 862, 0.9, "t", { tradeType: "arbitrage" });
    pf.markArb("381", "YES", 862, 862 * 0.9);
    pf.arbSets.set("2026:SENATE:NH", ["381", "382"]);
    await live.reconcile();
    expect(pf.arbQty("381", "YES")).toBe(0);
    const ex = new PaperExecutionClient(pf);
    const cfg = mergeStrategy({ yolo: false, name: "t", arbitrage: false });
    const books = new Map([["381", book("381", [[0.9, 5000]], [[0.91, 5000]])], ["382", book("382", [[0.05, 5000]], [[0.06, 5000]])]]);
    const st: MarketState = { now: new Date("2026-10-02T16:00:00Z"), markets, books, external: new Map(), headlines: new Map() };
    const r = runPortfolioTick({ state: st, signals: computeSignals(st, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "fixed_fractional", rules: null, tradedHeadlines: new Set() });
    expect(r.logs.some((l) => /ARB repair/.test(l.message))).toBe(false);
    expect(pf.holdings("382").YES).toBe(0);
  });
});

describe("liquidate all (switch to YOLO)", () => {
  it("sells every position at the best available prices and clears set records", async () => {
    const sig = fakeSig((l) => l.quantity);
    const pf = new Portfolio(100_000);
    const books = arbBooks();
    const live = new LiveTrader(sig.client, "t1", () => markets, () => pf, undefined, () => true, (id) => books.get(id));
    sig.held.set("1070", -500);
    sig.held.set("1071", -300);
    await live.reconcile(true);
    const left = await live.liquidateAll(2);
    expect(left).toBe(0);
    const sells = sig.calls.filter((c) => c.path === "/orders").map((c) => c.body as { action: string; side: string; quantity: number });
    expect(sells.every((x) => x.action === "sell" && x.side === "no")).toBe(true);
    expect(pf.arbSets.size).toBe(0);
  });
});
