import { describe, expect, it } from "vitest";
import { evaluateMarket, rankOpportunities } from "@/lib/core/opportunity";
import { book, fair } from "./helpers";

describe("opportunity engine", () => {
  const nh = book("381", [[0.825, 1000]], [[0.905, 1000]]);

  it("evaluates all four actions with net edge = fair - VWAP", () => {
    const opps = evaluateMarket({ marketId: "381", title: "NH", book: nh, fair: fair("381", 0.95), holdings: { YES: 0, NO: 0 } });
    expect(opps.map((o) => o.action)).toEqual(["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"]);
    const buyYes = opps.find((o) => o.action === "BUY_YES")!;
    expect(buyYes.netEdge).toBeCloseTo(0.95 - 0.905, 6);
    expect(buyYes.transactionCosts).toBe(0);
    expect(buyYes.netEdge).toBeCloseTo(buyYes.grossEdge - buyYes.spreadCost - buyYes.slippage, 6);
  });

  it("treats an unbacked SELL as its complement BUY (SIG canonicalisation)", () => {
    const opps = evaluateMarket({ marketId: "381", title: "NH", book: nh, fair: fair("381", 0.7), holdings: { YES: 0, NO: 0 } });
    const sellYes = opps.find((o) => o.action === "SELL_YES")!;
    const buyNo = opps.find((o) => o.action === "BUY_NO")!;
    expect(sellYes.equivalentTo).toEqual(["BUY_NO"]);
    expect(sellYes.vwap).toBeCloseTo(0.175);
    expect(sellYes.netEdge).toBeCloseTo(buyNo.netEdge);
    // Ranking keeps one of them, never both.
    const ranked = rankOpportunities(opps, 0.01, 0);
    expect(ranked.filter((o) => o.action === "SELL_YES" || o.action === "BUY_NO")).toHaveLength(1);
  });

  it("prices a backed SELL as a close at the bid", () => {
    const opps = evaluateMarket({ marketId: "381", title: "NH", book: nh, fair: fair("381", 0.8), holdings: { YES: 300, NO: 0 } });
    const s = opps.find((o) => o.action === "SELL_YES")!;
    expect(s.closesPosition).toBe(true);
    expect(s.vwap).toBeCloseTo(0.825);
    expect(s.netEdge).toBeCloseTo(0.825 - 0.8);
    expect(s.evaluatedQuantity).toBe(300);
  });

  it("finds nothing when fair value sits inside the spread", () => {
    const opps = evaluateMarket({ marketId: "381", title: "NH", book: nh, fair: fair("381", 0.865), holdings: { YES: 0, NO: 0 } });
    expect(rankOpportunities(opps, 0.01, 0)).toHaveLength(0);
  });
});
