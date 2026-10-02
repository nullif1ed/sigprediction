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
    if (path.endsWith("/portfolio/positions"))
      return json({ positions: [...held].filter(([, q]) => q !== 0).map(([exchangeId, q]) => ({ exchangeId, marketId: exchangeId === "1070" ? "381" : "382", marketTitle: "", settled: false, quantity: q, avgCost: 0.5, currentPrice: 0.5, marketValue: 0, costBasis: 0, lots: [] })), summary: {} });
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
  let ex: PaperExecutionClient | null = null;
  const live = new LiveTrader(sig.client, "t1", () => markets, () => pf, () => ex?.resetConsumption());
  ex = new PaperExecutionClient(pf, { onOrder: (o: PaperOrder) => live.capture(o) });
  const cfg = mergeStrategy({ name: "t" });
  const tick = (books: Map<string, YesBook>) => runPortfolioTick({ state: state(books), signals: computeSignals(state(books), cfg), cfg, portfolio: pf, exec: ex!, sizingMode: "fixed_fractional", rules: null, tradedHeadlines: new Set() });
  return { ...sig, pf, live, tick };
}

// YES bids 0.60 + 0.45 = 1.05: buying NO on both costs 0.95 per set and pays 1.
const arbBooks = () => new Map([["381", book("381", [[0.6, 500]], [[0.62, 500]])], ["382", book("382", [[0.45, 500]], [[0.47, 500]])]]);

describe("live execution", () => {
  it("sends an arbitrage set as ONE multi-leg request of on-tick limit orders, then reconciles", async () => {
    const t = setup((l) => l.quantity);
    await t.live.reconcile(true);
    t.tick(arbBooks());
    await t.live.flush();
    const ml = t.calls.filter((c) => c.path === "/orders/multi-leg");
    expect(ml).toHaveLength(1);
    const legs = ml[0].body!.legs as { side: string; action: string; quantity: number; price: number; exchangeId: string }[];
    expect(legs.map((l) => [l.exchangeId, l.side, l.action, l.quantity, l.price])).toEqual([
      ["1070", "no", "buy", 500, 0.4],
      ["1071", "no", "buy", 500, 0.55],
    ]);
    expect(typeof ml[0].body!.idempotencyKey).toBe("string");
    expect(t.calls.some((c) => c.path === "/orders/cancel-all")).toBe(false); // fully filled
    // Portfolio now mirrors the exchange.
    expect(t.pf.holdings("381").NO).toBe(500);
    expect(t.pf.arbQty("382", "NO")).toBe(500);
    expect(t.live.stats.sharesFilled).toBe(1000);
  });

  it("cancels resting remainders and repairs a set left with one short leg", async () => {
    // Leg 1070 fills completely, leg 1071 only 200 of 500.
    const t = setup((l) => (l.exchangeId === "1071" ? 200 : l.quantity));
    await t.live.reconcile(true);
    t.tick(arbBooks());
    await t.live.flush();
    expect(t.calls.some((c) => c.path === "/orders/cancel-all")).toBe(true);
    expect(t.pf.arbQty("381", "NO")).toBe(500);
    expect(t.pf.arbQty("382", "NO")).toBe(200);
    // Next tick: completing costs 0.40 + 0.55 = 0.95 < 1, so the short leg is bought, not dumped.
    const r = t.tick(arbBooks());
    expect(r.logs.some((l) => /ARB repair .* completed/.test(l.message))).toBe(true);
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
    const unwind = ml[1].body!.legs as { action: string; quantity: number }[];
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

describe("reconcile", () => {
  it("recognises a complete set held on SIG as arbitrage even without local records", async () => {
    const t = setup((l) => l.quantity);
    t.held.set("1070", -300);
    t.held.set("1071", -300);
    await t.live.reconcile(true);
    expect(t.pf.arbQty("381", "NO")).toBe(300);
    expect(t.pf.arbSets.get("2026:SENATE:NH")).toEqual(["381", "382"]);
  });
});
