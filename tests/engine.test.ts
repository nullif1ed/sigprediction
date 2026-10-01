import { describe, expect, it } from "vitest";
import { computeSignals, mergeStrategy, runPortfolioTick, type MarketState } from "@/lib/core/engine";
import { Portfolio } from "@/lib/core/portfolio";
import { PaperExecutionClient } from "@/lib/core/execution";
import { parseSigTitle } from "@/lib/core/races";
import type { ExternalQuote, NewsHeadline, SigMarket } from "@/lib/core/types";
import { book } from "./helpers";

const mk = (id: string, title: string): SigMarket => ({ id, exchangeId: "e" + id, title, status: "open", settlementDate: "2026-11-04T17:00:00Z", categories: [], race: parseSigTitle(title), latestPrice: null });
const markets = [mk("381", "Will the Democratic Party win the New Hampshire Senate?"), mk("382", "Will the Republican Party win the New Hampshire Senate?")];
const ext = (mid: number): ExternalQuote => ({ venue: "polymarket", externalId: "x", question: "", bid: mid - 0.005, ask: mid + 0.005, last: mid, mid, volume: 1e6, liquidity: 1e5, url: "", matchQuality: "equivalent", criteriaNote: "", fetchedAt: "" });
const now = new Date("2026-10-02T16:00:00Z");

function state(over: Partial<MarketState> = {}): MarketState {
  return {
    now,
    markets,
    books: new Map([
      ["381", book("381", [[0.7, 2000]], [[0.75, 2000]])],
      ["382", book("382", [[0.13, 2000]], [[0.17, 2000]])],
    ]),
    external: new Map([["381", [ext(0.86)]], ["382", [ext(0.14)]]]),
    headlines: new Map(),
    ...over,
  };
}

describe("strategy engine", () => {
  it("buys the underpriced side, sizes within limits and explains why", () => {
    const cfg = mergeStrategy({ name: "t" });
    const s = state();
    const pf = new Portfolio(100_000);
    const ex = new PaperExecutionClient(pf);
    ex.now = () => now;
    const r = runPortfolioTick({ state: s, signals: computeSignals(s, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "auto", rules: null, tradedHeadlines: new Set() });
    const d = r.decisions.find((x) => x.marketId === "381" && !x.rejected)!;
    expect(d.action).toBe("BUY_YES");
    expect(d.quantity).toBeGreaterThan(0);
    expect(d.estimatedCost).toBeLessThanOrEqual(100_000 * cfg.risk.maxPositionPct + 1);
    expect(d.reason).toMatch(/net edge/);
    expect(pf.holdings("381").YES).toBe(d.quantity);
    // Correlated D/R exposure stays inside the race cap.
    expect(pf.grossExposure()).toBeLessThanOrEqual(100_000 * cfg.risk.maxRacePct + 1e-6);
  });

  it("ignores headlines that were not yet known (no look-ahead)", () => {
    const future: NewsHeadline = { id: "h", marketId: "381", url: "", title: "Poll", source: "The New York Times", summary: "", publishedDate: "2026-10-03", relevanceExplanation: "raises the likelihood of a Democratic win", firstSeenAt: "2026-10-03T00:00:00Z" };
    const cfg = mergeStrategy({ name: "t" });
    const sNo = computeSignals(state(), cfg);
    const sFuture = computeSignals(state({ headlines: new Map([["381", [future]]]) }), cfg);
    expect(sFuture.headlines).toHaveLength(0);
    expect(sFuture.fair.get("381")!.fairProbability).toBe(sNo.fair.get("381")!.fairProbability);
    const sNow = computeSignals(state({ headlines: new Map([["381", [{ ...future, firstSeenAt: "2026-10-02T15:50:00Z" }]]]) }), cfg);
    expect(sNow.headlines.length).toBe(1);
    expect(sNow.headlines[0].shift).toBeGreaterThan(0);
  });

  it("trades a fresh headline once, tagged as a headline trade", () => {
    const h: NewsHeadline = { id: "h", marketId: "381", url: "", title: "Poll", source: "The New York Times", summary: "Democrat leading", publishedDate: "2026-10-02", relevanceExplanation: "raises the likelihood of a Democratic win and strengthens the lead", firstSeenAt: "2026-10-02T15:59:00Z" };
    const s = state({ books: new Map([["381", book("381", [[0.84, 2000]], [[0.86, 2000]])], ["382", book("382", [[0.13, 2000]], [[0.17, 2000]])]]), headlines: new Map([["381", [h]]]) });
    const cfg = mergeStrategy({ name: "t" });
    const pf = new Portfolio(100_000);
    const ex = new PaperExecutionClient(pf);
    const traded = new Set<string>();
    const r = runPortfolioTick({ state: s, signals: computeSignals(s, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "auto", rules: null, tradedHeadlines: traded });
    expect(r.decisions.some((d) => d.opportunityType === "headline")).toBe(true);
    expect(pf.get("381", "YES")?.tradeType).toBe("headline");
    const again = runPortfolioTick({ state: s, signals: computeSignals(s, cfg), cfg, portfolio: pf, exec: ex, sizingMode: "auto", rules: null, tradedHeadlines: traded });
    expect(again.decisions.some((d) => d.opportunityType === "headline")).toBe(false);
  });

  it("executes riskless arbitrage legs first", () => {
    const s = state({
      books: new Map([["381", book("381", [[0.6, 500]], [[0.62, 500]])], ["382", book("382", [[0.45, 500]], [[0.47, 500]])]]),
      external: new Map(),
    });
    const cfg = mergeStrategy({ name: "t" });
    const pf = new Portfolio(100_000);
    const ex = new PaperExecutionClient(pf);
    const sig = computeSignals(s, cfg);
    expect(sig.arbitrage[0].kind).toBe("buy_all_no");
    runPortfolioTick({ state: s, signals: sig, cfg, portfolio: pf, exec: ex, sizingMode: "fixed_fractional", rules: null, tradedHeadlines: new Set() });
    expect(pf.holdings("381").NO).toBeGreaterThan(0);
    expect(pf.holdings("382").NO).toBeGreaterThan(0);
  });
});
