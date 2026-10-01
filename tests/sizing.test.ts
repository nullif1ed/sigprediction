import { describe, expect, it } from "vitest";
import { constrainSize, DEFAULT_RISK, kelly, rawNotional, scenarioOf, selectStrategy } from "@/lib/core/sizing";
import { evaluateMarket } from "@/lib/core/opportunity";
import { book, fair } from "./helpers";

const opp = () =>
  evaluateMarket({ marketId: "1", title: "t", book: book("1", [[0.4, 5000]], [[0.42, 5000]]), fair: fair("1", 0.5, 0.8), holdings: { YES: 0, NO: 0 } }).find((o) => o.action === "BUY_YES")!;
const view = (o: Partial<{ equity: number; cash: number; gross: number; dd: number; mkt: number; race: number }> = {}) => ({
  equity: o.equity ?? 100_000,
  cash: o.cash ?? 100_000,
  grossExposure: o.gross ?? 0,
  drawdown: o.dd ?? 0,
  marketExposure: () => o.mkt ?? 0,
  raceExposure: () => o.race ?? 0,
});

describe("position sizing", () => {
  it("computes binary Kelly", () => {
    expect(kelly(0.5, 0.4)).toBeCloseTo(0.1 / 0.6);
    expect(kelly(0.3, 0.4)).toBe(0);
  });

  it("offers three strategies with different sizes", () => {
    const o = opp();
    const ff = rawNotional("fixed_fractional", o, 100_000, 0.02);
    const va = rawNotional("volatility_adjusted", o, 100_000, 0.02);
    const fk = rawNotional("fractional_kelly", o, 100_000, 0.02);
    expect(ff).toBe(1000);
    expect(va).toBeCloseTo(1500); // target 3pp / sd 2pp
    expect(fk).toBeGreaterThan(0);
  });

  it("never exceeds position, race, gross, cash or liquidity limits", () => {
    const o = opp();
    const huge = 1e9;
    expect(constrainSize(o, huge, view()).notional).toBeLessThanOrEqual(100_000 * DEFAULT_RISK.maxPositionPct + 1);
    expect(constrainSize(o, huge, view({ mkt: 4000 })).limitedBy).toBe("max_position");
    expect(constrainSize(o, huge, view({ race: 7900 })).limitedBy).toBe("max_race");
    expect(constrainSize(o, huge, view({ cash: 100 })).notional).toBeLessThanOrEqual(100);
    expect(constrainSize(o, huge, view({ gross: 80_000 })).quantity).toBe(0);
    expect(constrainSize(o, huge, view({ dd: 0.25 })).limitedBy).toBe("max_drawdown");
  });

  it("buckets scenarios and falls back to defaults until rules are learned", () => {
    const o = opp();
    const sc = scenarioOf(o, 30);
    expect(sc).toMatch(/high_edge\|high_conf\|deep\|far_res/);
    expect(selectStrategy(sc, null)).toBe("fractional_kelly");
    expect(selectStrategy(sc, { [sc]: { strategy: "fixed_fractional", trades: 10, avgPnl: 1 } })).toBe("fixed_fractional");
    expect(selectStrategy(sc, { [sc]: { strategy: "fixed_fractional", trades: 2, avgPnl: 1 } })).toBe("fractional_kelly");
  });
});
