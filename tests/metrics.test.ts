import { describe, expect, it } from "vitest";
import { computeMetrics, maxDrawdown, sharpe } from "@/lib/core/metrics";

const curve = [100, 102, 101, 104, 99, 105].map((e, i) => ({ t: new Date(Date.UTC(2026, 9, 1, 16, i)).toISOString(), equity: e * 1000, exposure: 50_000 }));
const long = Array.from({ length: 120 }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 1, 16, i)).toISOString(), equity: 100_000 + i * 10 + (i % 3) * 5 }));

describe("performance metrics", () => {
  it("computes drawdown, sharpe and trade stats", () => {
    expect(maxDrawdown(curve)).toBeCloseTo((104 - 99) / 104, 4);
    expect(sharpe(curve).sharpe).toBeNull(); // too short to annualise
    expect(sharpe(long).sharpe).toBeGreaterThan(0);
    const m = computeMetrics({ startingCapital: 100_000, curve, closedTrades: [{ pnl: 10 }, { pnl: -5 }, { pnl: 20 }], numTrades: 6, tradedNotional: 50_000 });
    expect(m.totalReturn).toBeCloseTo(0.05);
    expect(m.winRate).toBeCloseTo(2 / 3, 4);
    expect(m.profitFactor).toBeCloseTo(6);
    expect(m.turnover).toBeCloseTo(0.5);
    expect(m.capitalUtilization).toBeGreaterThan(0.45);
  });
});
