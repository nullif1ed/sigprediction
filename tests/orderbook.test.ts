import { describe, expect, it } from "vitest";
import { availableQuantity, bookStats, complementOf, consume, contractLevels, contractMid, simulateExecution, snapToTick } from "@/lib/core/orderbook";
import { book, fixture } from "./helpers";
import type { Level } from "@/lib/core/types";

describe("order book engine", () => {
  // Displayed SIG prices for "Will the Democratic Party win the New Hampshire Senate?"
  const nh = book("381", [[0.825, 1000]], [[0.905, 1000]]);

  it("derives the four executable prices from a single YES book", () => {
    expect(contractLevels(nh, "BUY_YES")[0].price).toBe(0.905);
    expect(contractLevels(nh, "SELL_YES")[0].price).toBe(0.825);
    expect(contractLevels(nh, "BUY_NO")[0].price).toBe(0.175);
    expect(contractLevels(nh, "SELL_NO")[0].price).toBe(0.095);
  });

  it("computes VWAP across levels instead of assuming the touch", () => {
    const b = book("m", [[0.2, 500]], [[0.225, 200], [0.23, 800], [0.24, 1000]]);
    const ex = simulateExecution(b, "BUY_YES", 1000);
    expect(ex.filled).toBe(1000);
    expect(ex.vwap).toBeCloseTo((200 * 0.225 + 800 * 0.23) / 1000, 9);
    expect(ex.slippage).toBeCloseTo(0.229 - 0.225, 9);
    expect(ex.levelsUsed).toBe(2);
  });

  it("partially fills when liquidity runs out and honours limits", () => {
    const ex = simulateExecution(nh, "BUY_YES", 1500);
    expect(ex.filled).toBe(1000);
    const b = book("m", [], [[0.5, 100], [0.6, 100]]);
    expect(simulateExecution(b, "BUY_YES", 200, 0.55).filled).toBe(100);
    expect(availableQuantity(b, "BUY_YES")).toBe(200);
  });

  it("reports spread, mid and imbalance", () => {
    const s = bookStats(nh);
    expect(s.mid).toBeCloseTo(0.865);
    expect(s.spread).toBeCloseTo(0.08);
    expect(s.imbalance).toBe(0);
    expect(contractMid(nh, "NO")).toBeCloseTo(0.135);
  });

  it("consumes liquidity on the correct side", () => {
    const after = consume(nh, "BUY_NO", 400); // BUY NO hits YES bids
    expect(after.bids[0].quantity).toBe(600);
    expect(after.asks[0].quantity).toBe(1000);
  });

  it("maps complement actions and ticks", () => {
    expect(complementOf("SELL_YES")).toBe("BUY_NO");
    expect(complementOf("SELL_NO")).toBe("BUY_YES");
    expect(snapToTick(0.4237, "down")).toBe(0.42);
    expect(snapToTick(0.4237, "up")).toBe(0.425);
  });

  it("parses a real SIG orderbook fixture", () => {
    const raw = fixture<{ exchanges: { bids: Level[]; asks: Level[] }[] }>("sig-orderbook-381.json");
    const b = book("381", raw.exchanges[0].bids.map((l) => [l.price, l.quantity]), raw.exchanges[0].asks.map((l) => [l.price, l.quantity]));
    expect(b.bids[0].price).toBeLessThan(b.asks[0].price);
  });
});
