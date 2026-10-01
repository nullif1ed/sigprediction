import { describe, expect, it } from "vitest";
import { estimateFairValue } from "@/lib/core/fairValue";
import type { ExternalQuote } from "@/lib/core/types";

const ext = (venue: "polymarket" | "kalshi", mid: number, spread = 0.01, volume = 500_000): ExternalQuote => ({
  venue, externalId: venue, question: "", bid: mid - spread / 2, ask: mid + spread / 2, last: mid, mid, volume, liquidity: null, url: "", matchQuality: "equivalent", criteriaNote: "", fetchedAt: "",
});
const base = { marketId: "1", headlines: [], imbalance: 0, momentum: null, complementMid: null, daysToResolution: 30 };

describe("fair value engine", () => {
  it("leans toward tight, liquid external markets over a wide SIG quote", () => {
    const f = estimateFairValue({ ...base, sigQuote: { bid: 0.825, ask: 0.905 }, external: [ext("polymarket", 0.855), ext("kalshi", 0.865)] })!;
    expect(f.fairProbability).toBeGreaterThan(0.855);
    expect(f.fairProbability).toBeLessThan(0.866);
    expect(f.lowerBound).toBeLessThan(f.fairProbability);
    expect(f.upperBound).toBeGreaterThan(f.fairProbability);
  });

  it("separates probability from confidence", () => {
    const agree = estimateFairValue({ ...base, sigQuote: { bid: 0.49, ask: 0.51 }, external: [ext("polymarket", 0.5), ext("kalshi", 0.5)] })!;
    const disagree = estimateFairValue({ ...base, sigQuote: { bid: 0.49, ask: 0.51 }, external: [ext("polymarket", 0.35), ext("kalshi", 0.65)] })!;
    expect(agree.fairProbability).toBeCloseTo(disagree.fairProbability, 1);
    expect(agree.confidence).toBeGreaterThan(disagree.confidence);
  });

  it("returns null with no information", () => {
    expect(estimateFairValue({ ...base, sigQuote: { bid: null, ask: null }, external: [] })).toBeNull();
  });
});
