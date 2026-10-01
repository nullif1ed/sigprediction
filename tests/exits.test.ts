import { describe, expect, it } from "vitest";
import { DEFAULT_EXITS, shouldExit, sizeUnwind, type ExitState } from "@/lib/core/exits";
import type { Position } from "@/lib/core/types";
import { book } from "./helpers";

const pos = (o: Partial<Position & ExitState> = {}): Position & ExitState => ({
  marketId: "1", contract: "YES", quantity: 100, avgEntry: 0.905, lots: [{ quantity: 100, price: 0.905 }], openedAt: "2026-10-01T16:00:00Z",
  entryFair: 0.95, entryLiquidationValue: 0.825, tradeType: "regular", realizedPnl: 0, ...o,
});
const now = new Date("2026-10-01T17:00:00Z");

describe("exit logic", () => {
  it("does not stop out just because an 8-point spread was paid on entry", () => {
    const r = shouldExit({ position: pos(), book: book("1", [[0.825, 1000]], [[0.905, 1000]]), contractFair: 0.95, daysToResolution: 30, now });
    expect(r.exit).toBe(false);
  });

  it("takes profit only on shares that actually clear the target, with a limit", () => {
    // 60 shares at 0.93 clear entry + 1pp (0.915); the next level (0.90) is below entry.
    const r = shouldExit({ position: pos(), book: book("1", [[0.93, 60], [0.9, 1000]], [[0.95, 1000]]), contractFair: 0.99, daysToResolution: 30, now });
    expect(r.reason).toBe("profit_target");
    expect(r.quantity).toBe(60);
    expect(r.limitPrice).toBeCloseTo(0.915);
    // A post-entry rise that is still below the entry price is not a "profit".
    expect(shouldExit({ position: pos(), book: book("1", [[0.86, 1000]], [[0.9, 1000]]), contractFair: 0.99, daysToResolution: 30, now }).exit).toBe(false);
  });

  it("confirms a stop over consecutive ticks before selling", () => {
    const p = pos({ avgEntry: 0.9, lots: [{ quantity: 100, price: 0.9 }], entryLiquidationValue: 0.89 });
    const b = book("1", [[0.83, 1000]], [[0.85, 1000]]);
    expect(shouldExit({ position: p, book: b, contractFair: 0.88, daysToResolution: 30, now }).exit).toBe(false);
    const r = shouldExit({ position: p, book: b, contractFair: 0.88, daysToResolution: 30, now });
    expect(r.reason).toBe("stop_loss");
    expect(r.limitPrice).toBeCloseTo(0.81); // never walks more than 2pp below the touch
  });

  it("does not dump into a dislocated book (bids pulled far below fair value)", () => {
    // Real case, market 387 at 18:09:55: bids collapsed to 0.16-0.68 while fair was ~0.98.
    const p = pos({ avgEntry: 0.97, lots: [{ quantity: 3000, price: 0.97 }], quantity: 3000, entryLiquidationValue: 0.955 });
    const b = book("1", [[0.68, 96], [0.16, 630708]], [[0.98, 7972]]);
    for (let i = 0; i < 5; i++) expect(shouldExit({ position: p, book: b, contractFair: 0.98, daysToResolution: 30, now }).exit).toBe(false);
    // Without the dislocation guard the same book triggers the stop.
    const raw = shouldExit({ position: pos({ ...p, stopStrikes: 5 }), book: b, contractFair: 0.98, daysToResolution: 30, now, cfg: { ...DEFAULT_EXITS, dislocationPp: 1 } });
    expect(raw.reason).toBe("stop_loss");
    expect(raw.quantity).toBe(96); // and the limit stops it from selling the 0.16 level
  });

  it("exits at fair value only on the profitable part", () => {
    const p = pos({ avgEntry: 0.5, lots: [{ quantity: 100, price: 0.5 }], entryLiquidationValue: 0.49 });
    const cfg = { ...DEFAULT_EXITS, takeProfitPp: 1, profitTarget: 1 };
    const r = shouldExit({ position: p, book: book("1", [[0.605, 40], [0.45, 1000]], [[0.62, 1000]]), contractFair: 0.61, daysToResolution: 30, now, cfg });
    expect(r.reason).toBe("fair_value_reached");
    expect(r.quantity).toBe(40);
  });

  it("arms a breakeven exit after real profit was available", () => {
    const p = pos({ avgEntry: 0.9, lots: [{ quantity: 100, price: 0.9 }], entryLiquidationValue: 0.895 });
    const cfg = { ...DEFAULT_EXITS, takeProfitPp: 0.05, profitTarget: 1 };
    expect(shouldExit({ position: p, book: book("1", [[0.92, 10]], [[0.93, 10]]), contractFair: 0.99, daysToResolution: 30, now, cfg }).exit).toBe(false);
    const r = shouldExit({ position: p, book: book("1", [[0.895, 1000]], [[0.9, 1000]]), contractFair: 0.99, daysToResolution: 30, now, cfg });
    expect(r.reason).toBe("breakeven_stop");
  });

  it("flattens near resolution and time-decays headline trades", () => {
    const b = book("1", [[0.825, 1000]], [[0.905, 1000]]);
    expect(shouldExit({ position: pos(), book: b, contractFair: 0.95, daysToResolution: 0.5, now }).reason).toBe("near_resolution");
    expect(shouldExit({ position: pos({ tradeType: "headline" }), book: b, contractFair: 0.95, daysToResolution: 30, now }).reason).toBe("headline_time_decay");
  });

  it("values NO positions at 1 - YES ask", () => {
    const r = shouldExit({ position: pos({ contract: "NO", avgEntry: 0.175, lots: [{ quantity: 100, price: 0.175 }], entryLiquidationValue: 0.095 }), book: book("1", [[0.825, 1000]], [[0.905, 1000]]), contractFair: 0.2, daysToResolution: 30, now });
    expect(r.exitPrice).toBeCloseTo(0.095);
  });
});

describe("arbitrage unwind sizing", () => {
  it("sells held sets only while the marginal proceeds clear the threshold", () => {
    // NO proceeds = 1 - YES ask. Level 1: 0.14 + 0.86 = 1.00, level 2: 0.13 + 0.855 = 0.985.
    const legs = [
      { marketId: "a", action: "SELL_NO" as const, book: book("a", [[0.8, 10]], [[0.86, 100], [0.87, 500]]), held: 300 },
      { marketId: "b", action: "SELL_NO" as const, book: book("b", [[0.1, 10]], [[0.14, 200], [0.145, 500]]), held: 300 },
    ];
    const u = sizeUnwind(legs, 0.995)!;
    expect(u.q).toBe(100);
    expect(u.proceeds / u.q).toBeCloseTo(1.0);
    expect(sizeUnwind(legs, 1.01)).toBeNull();
  });
});

describe("mean-reversion exit", () => {
  it("exits at about entry once the mispricing has closed, instead of waiting for the target", () => {
    const p = pos({ avgEntry: 0.9, lots: [{ quantity: 100, price: 0.9 }], entryLiquidationValue: 0.89 });
    const cfg = { ...DEFAULT_EXITS, takeProfitPp: 0.05, profitTarget: 1, breakevenArmPp: 1 };
    // Fair 0.90, mid 0.90: no edge left; bid 0.895 is within the 0.5pp scratch allowance.
    const r = shouldExit({ position: p, book: book("1", [[0.895, 500]], [[0.905, 500]]), contractFair: 0.9, daysToResolution: 30, now, cfg });
    expect(r.reason).toBe("mean_reverted");
    expect(r.limitPrice).toBeCloseTo(0.895);
    // Edge still open (fair 0.95): hold.
    expect(shouldExit({ position: p, book: book("1", [[0.895, 500]], [[0.905, 500]]), contractFair: 0.95, daysToResolution: 30, now, cfg }).exit).toBe(false);
  });
});
