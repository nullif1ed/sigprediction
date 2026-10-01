import { describe, expect, it } from "vitest";
import { shouldExit } from "@/lib/core/exits";
import type { Position } from "@/lib/core/types";
import { book } from "./helpers";

const pos = (o: Partial<Position> = {}): Position => ({
  marketId: "1", contract: "YES", quantity: 100, avgEntry: 0.905, lots: [{ quantity: 100, price: 0.905 }], openedAt: "2026-10-01T16:00:00Z",
  entryFair: 0.95, entryLiquidationValue: 0.825, tradeType: "regular", realizedPnl: 0, ...o,
});
const now = new Date("2026-10-01T17:00:00Z");

describe("exit logic", () => {
  it("does not stop out just because an 8-point spread was paid on entry", () => {
    const r = shouldExit({ position: pos(), book: book("1", [[0.825, 1000]], [[0.905, 1000]]), contractFair: 0.95, daysToResolution: 30, now });
    expect(r.exit).toBe(false);
  });
  it("takes profit, stops out and exits when the edge is gone", () => {
    expect(shouldExit({ position: pos(), book: book("1", [[0.93, 1000]], [[0.95, 1000]]), contractFair: 0.99, daysToResolution: 30, now }).reason).toBe("profit_target");
    // A post-entry rise that is still below the entry price is not a "profit".
    expect(shouldExit({ position: pos(), book: book("1", [[0.86, 1000]], [[0.9, 1000]]), contractFair: 0.99, daysToResolution: 30, now }).exit).toBe(false);
    expect(shouldExit({ position: pos(), book: book("1", [[0.8, 1000]], [[0.9, 1000]]), contractFair: 0.95, daysToResolution: 30, now }).reason).toBe("stop_loss");
    const p = pos({ avgEntry: 0.5, lots: [{ quantity: 100, price: 0.5 }], entryLiquidationValue: 0.6 });
    expect(shouldExit({ position: p, book: book("1", [[0.605, 1000]], [[0.62, 1000]]), contractFair: 0.61, daysToResolution: 30, now, cfg: { profitTarget: 1, stopLoss: 1, fairValueBuffer: 0.005, minDaysToResolution: 0, headlineMaxAgeMinutes: 60, exitOnIlliquid: false } }).reason).toBe("fair_value_reached");
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
