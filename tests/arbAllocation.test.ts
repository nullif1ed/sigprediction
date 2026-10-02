import { describe, expect, it } from "vitest";
import { detectArbitrage, sizeSet } from "@/lib/core/arbitrage";
import { allocateArbitrage, type ArbCandidate } from "@/lib/core/arbAllocation";
import { computeSignals, mergeStrategy, runPortfolioTick, type MarketState } from "@/lib/core/engine";
import { Portfolio } from "@/lib/core/portfolio";
import { PaperExecutionClient } from "@/lib/core/execution";
import { parseSigTitle, raceId } from "@/lib/core/races";
import type { SigMarket } from "@/lib/core/types";
import { book } from "./helpers";

const race = (st: string, p: "Democratic" | "Republican") => parseSigTitle(`Will the ${p} Party win the ${st} Senate?`)!;

describe("arbitrage set sizing (marginal, depth-aware)", () => {
  it("keeps buying deeper levels only while each marginal set is still profitable", () => {
    // NO legs: D NO 0.05 x1000, 0.06 x1000, 0.10 x1000 ; R NO 0.92 x1000, 0.93 x1000, 0.95 x1000
    const d = book("353", [[0.95, 1000], [0.94, 1000], [0.9, 1000]], [[0.97, 1000]]);
    const r = book("386", [[0.08, 1000], [0.07, 1000], [0.05, 1000]], [[0.16, 1000]]);
    const s = sizeSet([{ marketId: "353", action: "BUY_NO", book: d }, { marketId: "386", action: "BUY_NO", book: r }], 1)!;
    // Level 1: 0.05 + 0.92 = 0.97 (profit 0.03); level 2: 0.06 + 0.93 = 0.99 (0.01); level 3: 0.10 + 0.95 = 1.05 (loss).
    expect(s.q).toBe(2000);
    expect(s.tranches).toEqual([{ quantity: 1000, costPerSet: 0.97 }, { quantity: 1000, costPerSet: 0.99 }]);
    expect(1 * s.q - s.cost).toBeCloseTo(40, 6); // 30 + 10: the maximum attainable profit
  });

  it("detects a Delaware-style set with its full ladder", () => {
    const arbs = detectArbitrage([
      { marketId: "353", race: race("Delaware", "Democratic"), book: book("353", [[0.95, 1000], [0.94, 4000]], [[0.99, 100]]) },
      { marketId: "386", race: race("Delaware", "Republican"), book: book("386", [[0.08, 1000], [0.07, 3000]], [[0.16, 100]]) },
    ]);
    const a = arbs.find((x) => x.kind === "buy_all_no")!;
    expect(a.quantity).toBe(4000); // 1000 @0.97 + 3000 @0.99 (D's extra 1000 has no R partner)
    expect(a.totalProfit).toBeCloseTo(1000 * 0.03 + 3000 * 0.01, 4);
    expect(a.returnOnCapital).toBeGreaterThan(0);
  });
});

describe("capital allocation across simultaneous arbitrage sets", () => {
  const arb = (id: string, tranches: [number, number][], conditional = false) => ({
    kind: conditional ? ("buy_all_yes" as const) : ("buy_all_no" as const),
    raceId: id,
    legs: [],
    tranches: tranches.map(([quantity, costPerSet]) => ({ quantity, costPerSet })),
    quantity: tranches.reduce((s, t) => s + t[0], 0),
    costPerSet: tranches[0][1],
    guaranteedPayoutPerSet: 1,
    profitPerSet: 1 - tranches[0][1],
    totalProfit: 0,
    returnOnCapital: (1 - tranches[0][1]) / tranches[0][1],
    conditional,
    note: "",
  });
  const cand = (a: ReturnType<typeof arb>, convergence = 1, days = 34): ArbCandidate => ({ arb: a, convergence, daysToSettlement: days });
  const lim = (budget: number, raceCap = 1e12) => ({ budget, raceCap: () => raceCap, minQuantity: 10, minReturn: 0.005 });

  it("opens every profitable set when capital is ample", () => {
    const r = allocateArbitrage([cand(arb("A", [[1000, 0.97]])), cand(arb("B", [[2000, 0.98]]))], lim(1e6));
    expect(Object.fromEntries(r.map((x) => [x.arb.raceId, x.quantity]))).toEqual({ A: 1000, B: 2000 });
    expect(r.reduce((s, x) => s + x.expectedProfit, 0)).toBeCloseTo(30 + 40, 4);
  });

  it("funds the best return on capital first when capital is scarce", () => {
    // A (3.1% return) is funded fully before B (2.0%) even though B has more depth;
    // the leftover 30 SUSQies then buy 30 B sets rather than sitting idle.
    const r = allocateArbitrage([cand(arb("B", [[5000, 0.98]])), cand(arb("A", [[1000, 0.97]]))], lim(1000));
    const q = Object.fromEntries(r.map((x) => [x.arb.raceId, x.quantity]));
    expect(q).toEqual({ A: 1000, B: 30 });
    expect(r.reduce((s, x) => s + x.cost, 0)).toBeLessThanOrEqual(1000);
  });

  it("interleaves tranches: a set's deep, worse level competes with another set's top", () => {
    const A = arb("A", [[1000, 0.95], [1000, 0.995]]); // 5.3% then 0.5%
    const B = arb("B", [[1000, 0.98]]); // 2.0%
    const r = allocateArbitrage([cand(A), cand(B)], lim(950 + 980 + 10));
    const byId = Object.fromEntries(r.map((x) => [x.arb.raceId, x.quantity]));
    // Order funded: A@0.95 (5.3%), B@0.98 (2.0%), then the last 10 SUSQies into A@0.995 (0.5%).
    expect(byId).toEqual({ A: 1010, B: 1000 });
  });

  it("respects per-race caps and discounts sets by convergence risk", () => {
    const r = allocateArbitrage([cand(arb("A", [[10_000, 0.97]]))], lim(1e6, 500));
    expect(r[0].quantity).toBe(515);
    expect(r[0].limitedBy).toBe("race_cap");
    // A buy-all-YES set at 0.97 that pays only if a listed party wins (P = 0.96) has negative EV.
    expect(allocateArbitrage([cand(arb("C", [[1000, 0.97]], true), 0.96)], lim(1e6))).toHaveLength(0);
    expect(allocateArbitrage([cand(arb("C", [[1000, 0.97]], true), 0.995)], lim(1e6))[0].expectedProfit).toBeCloseTo(25, 4);
  });

  it("prefers the faster-settling set at equal return", () => {
    const r = allocateArbitrage([cand(arb("slow", [[1000, 0.97]]), 1, 60), cand(arb("fast", [[1000, 0.97]]), 1, 10)], lim(970));
    expect(r[0].arb.raceId).toBe("fast");
  });
});

describe("engine arbitrage execution", () => {
  const mk = (id: string, title: string): SigMarket => ({ id, exchangeId: "e" + id, title, status: "open", settlementDate: "2026-11-04T17:00:00Z", categories: [], race: parseSigTitle(title), latestPrice: null });
  const markets = [
    mk("353", "Will the Democratic Party win the Delaware Senate?"),
    mk("386", "Will the Republican Party win the Delaware Senate?"),
    mk("381", "Will the Democratic Party win the New Hampshire Senate?"),
    mk("382", "Will the Republican Party win the New Hampshire Senate?"),
  ];
  const books = () =>
    new Map([
      ["353", book("353", [[0.95, 1000], [0.94, 3000]], [[0.99, 100]], "a")],
      ["386", book("386", [[0.08, 1000], [0.07, 3000]], [[0.16, 100]], "a")],
      ["381", book("381", [[0.6, 2000]], [[0.62, 2000]], "a")],
      ["382", book("382", [[0.42, 2000]], [[0.45, 2000]], "a")],
    ]);
  const state = (b = books()): MarketState => ({ now: new Date("2026-10-02T16:00:00Z"), markets, books: b, external: new Map(), headlines: new Map() });

  it("opens multiple sets at once, sized by depth and capital, and does not re-buy the same liquidity", () => {
    const cfg = mergeStrategy({ yolo: false, name: "arb", minNetEdge: 1 }); // isolate arbitrage
    const pf = new Portfolio(100_000);
    const races = new Map(markets.map((m) => [m.id, raceId(m.race!)]));
    pf.raceOf = (id) => races.get(id) ?? id;
    const ex = new PaperExecutionClient(pf);
    const s = state();
    runPortfolioTick({ state: s, signals: computeSignals(s, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "auto", rules: null, tradedHeadlines: new Set() });
    // Delaware: 4000 sets (1000 @0.97 + 3000 @0.99). NH: bids 0.60 + 0.42 = 1.02 -> 2000 sets @0.98.
    expect(pf.holdings("353").NO).toBe(4000);
    expect(pf.holdings("386").NO).toBe(4000);
    expect(pf.holdings("381").NO).toBe(2000);
    expect(pf.holdings("382").NO).toBe(2000);
    const cost = pf.grossExposure();
    expect(cost).toBeLessThanOrEqual(100_000 * cfg.risk.maxArbitragePct);
    // Locked profit = guaranteed payout (1 per set) - cost.
    expect(6000 - cost).toBeCloseTo(1000 * 0.03 + 3000 * 0.01 + 2000 * 0.02, 2);

    // Next poll shows the same displayed book (paper fills never reach SIG): nothing new to buy.
    const s2 = state(books());
    const r2 = runPortfolioTick({ state: s2, signals: computeSignals(s2, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "auto", rules: null, tradedHeadlines: new Set() });
    expect(r2.decisions.filter((d) => d.opportunityType === "arbitrage")).toHaveLength(0);
    expect(pf.holdings("353").NO).toBe(4000);
    // Arbitrage legs are held to settlement, never exited one at a time.
    expect(r2.exits).toHaveLength(0);
  });

  it("caps each race and total arbitrage capital", () => {
    const cfg = mergeStrategy({ yolo: false, name: "arb", minNetEdge: 1, risk: { ...mergeStrategy({ name: "x" }).risk, maxArbRacePct: 0.01 } });
    const pf = new Portfolio(100_000);
    const races = new Map(markets.map((m) => [m.id, raceId(m.race!)]));
    pf.raceOf = (id) => races.get(id) ?? id;
    const ex = new PaperExecutionClient(pf);
    const s = state();
    runPortfolioTick({ state: s, signals: computeSignals(s, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "auto", rules: null, tradedHeadlines: new Set() });
    expect(pf.raceExposure("353")).toBeLessThanOrEqual(1000 + 1e-6);
    expect(pf.raceExposure("381")).toBeLessThanOrEqual(1000 + 1e-6);
    expect(pf.holdings("353").NO).toBe(pf.holdings("386").NO); // legs always matched
  });
});
