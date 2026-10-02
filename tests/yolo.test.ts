import { describe, expect, it } from "vitest";
import { computeSignals, mergeStrategy, runPortfolioTick, type MarketState } from "@/lib/core/engine";
import { Portfolio } from "@/lib/core/portfolio";
import { PaperExecutionClient } from "@/lib/core/execution";
import { parseSigTitle } from "@/lib/core/races";
import type { SigMarket, YesBook } from "@/lib/core/types";
import { book } from "./helpers";

const mk = (id: string, title: string): SigMarket => ({ id, exchangeId: "e" + id, title, status: "open", settlementDate: "2026-11-04T17:00:00Z", categories: [], race: parseSigTitle(title), latestPrice: null });
const markets = [
  mk("381", "Will the Democratic Party win the New Hampshire Senate?"),
  mk("382", "Will the Republican Party win the New Hampshire Senate?"),
  mk("377", "Will the Democratic Party win the Alaska Senate?"),
  mk("378", "Will the Republican Party win the Alaska Senate?"),
];
const run = (pf: Portfolio, ex: PaperExecutionClient, books: Map<string, YesBook>) => {
  const st: MarketState = { now: new Date("2026-10-02T16:00:00Z"), markets, books, external: new Map(), headlines: new Map() };
  const cfg = mergeStrategy({ name: "y" });
  return runPortfolioTick({ state: st, signals: computeSignals(st, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "fixed_fractional", rules: null, tradedHeadlines: new Set() });
};
// NH: YES bids 0.60 + 0.45 -> NO set costs 0.95 (5pp). AK: bids 0.52 + 0.49 -> 0.99 (1pp).
const both = () =>
  new Map([
    ["381", book("381", [[0.6, 50_000]], [[0.62, 50_000]])],
    ["382", book("382", [[0.45, 50_000]], [[0.47, 50_000]])],
    ["377", book("377", [[0.52, 50_000]], [[0.53, 50_000]])],
    ["378", book("378", [[0.49, 50_000]], [[0.5, 50_000]])],
  ]);

describe("YOLO arbitrage", () => {
  it("goes all in on the most profitable set first, with no per-race cap", () => {
    const pf = new Portfolio(100_000);
    run(pf, new PaperExecutionClient(pf), both());
    expect(pf.arbQty("381", "NO")).toBe(50_000); // NH: all its depth (47.5k of capital)
    expect(pf.arbQty("377", "NO")).toBe(50_000); // the rest goes to AK, limited by its depth
    expect(pf.cash).toBeLessThan(5_000);
  });

  it("sells a set once it converged (remaining profit < 1c) at a gain", () => {
    const pf = new Portfolio(100_000);
    const ex = new PaperExecutionClient(pf);
    run(pf, ex, new Map([["381", book("381", [[0.6, 1000]], [[0.62, 1000]])], ["382", book("382", [[0.45, 1000]], [[0.47, 1000]])]]));
    expect(pf.arbQty("381", "NO")).toBe(1000);
    // YES asks 0.605 + 0.39 = 0.995: selling both NO legs returns 0.995 >= 1 - 1c and > cost 0.95.
    const r = run(pf, ex, new Map([["381", book("381", [[0.6, 5000]], [[0.605, 5000]])], ["382", book("382", [[0.385, 5000]], [[0.39, 5000]])]]));
    expect(r.logs.some((l) => /YOLO converged 2026:SENATE:NH: sold 1000 of 1000/.test(l.message))).toBe(true);
    expect(pf.arbQty("381", "NO")).toBe(0);
  });

  it("rotates out of a weak set when a much better one appears and cash is used up", () => {
    const pf = new Portfolio(10_000);
    const ex = new PaperExecutionClient(pf);
    // Only AK at first (1pp): all 10k goes in.
    run(pf, ex, new Map([["377", book("377", [[0.52, 50_000]], [[0.525, 50_000]])], ["378", book("378", [[0.49, 50_000]], [[0.495, 50_000]])]]));
    expect(pf.arbQty("377", "NO")).toBeGreaterThan(9000);
    // NH appears at 5pp; AK can be sold back for 0.98 (gives up ~2pp x 10k sets = ~200).
    const r = run(pf, ex, new Map([
      ["377", book("377", [[0.52, 50_000]], [[0.525, 50_000]])],
      ["378", book("378", [[0.49, 50_000]], [[0.495, 50_000]])],
      ["381", book("381", [[0.6, 50_000]], [[0.62, 50_000]])],
      ["382", book("382", [[0.45, 50_000]], [[0.47, 50_000]])],
    ]));
    expect(r.logs.some((l) => /YOLO rotate 2026:SENATE:AK -> 2026:SENATE:NH/.test(l.message))).toBe(true);
    expect(pf.arbQty("377", "NO")).toBe(0);
  });
});
