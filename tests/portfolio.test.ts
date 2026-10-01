import { describe, expect, it } from "vitest";
import { Portfolio } from "@/lib/core/portfolio";
import { book } from "./helpers";

describe("portfolio engine", () => {
  it("tracks cash, average entry and realized P&L", () => {
    const p = new Portfolio(1000);
    p.applyFill("1", "BUY_YES", 100, 0.4, "t");
    p.applyFill("1", "BUY_YES", 100, 0.5, "t");
    expect(p.get("1", "YES")!.avgEntry).toBeCloseTo(0.45);
    expect(p.cash).toBeCloseTo(910);
    const r = p.applyFill("1", "SELL_YES", 150, 0.6, "t"); // FIFO: 100@0.4 + 50@0.5
    expect(r).toBeCloseTo(100 * 0.2 + 50 * 0.1);
    expect(p.holdings("1").YES).toBe(50);
  });

  it("nets an opposite BUY against held shares (YES + NO = 1)", () => {
    const p = new Portfolio(1000);
    p.applyFill("1", "BUY_YES", 100, 0.6, "t");
    const r = p.applyFill("1", "BUY_NO", 100, 0.3, "t"); // closes YES at 1 - 0.3 = 0.7
    expect(r).toBeCloseTo(10);
    expect(p.holdings("1")).toEqual({ YES: 0, NO: 0 });
    expect(p.cash).toBeCloseTo(1010);
  });

  it("canonicalises an unbacked SELL into the complement BUY", () => {
    const p = new Portfolio(1000);
    p.applyFill("1", "SELL_YES", 10, 0.825, "t");
    expect(p.holdings("1")).toEqual({ YES: 0, NO: 10 });
    expect(p.get("1", "NO")!.avgEntry).toBeCloseTo(0.175);
    expect(p.cash).toBeCloseTo(1000 - 1.75);
  });

  it("settles, marks to market and tracks drawdown", () => {
    const p = new Portfolio(1000);
    p.applyFill("1", "BUY_YES", 100, 0.5, "t");
    const s = p.snapshot(new Map([["1", book("1", [[0.3, 10]], [[0.35, 10]])]]), "t");
    expect(s.equity).toBeCloseTo(950 + 100 * 0.325);
    expect(s.liquidationEquity).toBeCloseTo(950 + 30);
    expect(s.drawdown).toBeGreaterThan(0);
    expect(p.settle("1", 1)).toBeCloseTo(50);
    expect(p.cash).toBeCloseTo(1050);
  });

  it("round-trips through JSON", () => {
    const p = new Portfolio(1000);
    p.applyFill("1", "BUY_NO", 20, 0.2, "t");
    const q = Portfolio.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
    expect(q.holdings("1")).toEqual({ YES: 0, NO: 20 });
    expect(q.cash).toBeCloseTo(p.cash);
  });
});
