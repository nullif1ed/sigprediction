import { describe, expect, it } from "vitest";
import { detectArbitrage } from "@/lib/core/arbitrage";
import { parseSigTitle } from "@/lib/core/races";
import { book } from "./helpers";

const D = parseSigTitle("Will the Democratic Party win the New Hampshire Senate?")!;
const R = parseSigTitle("Will the Republican Party win the New Hampshire Senate?")!;

describe("arbitrage detection", () => {
  it("finds no arbitrage on the real NH Senate quotes", () => {
    const arbs = detectArbitrage([
      { marketId: "381", race: D, book: book("381", [[0.825, 1000]], [[0.905, 1000]]) },
      { marketId: "382", race: R, book: book("382", [[0.105, 1000]], [[0.185, 1000]]) },
    ]);
    expect(arbs).toHaveLength(0);
  });

  it("buys NO on both sides when YES bids across exclusive outcomes sum above 1", () => {
    const arbs = detectArbitrage([
      { marketId: "381", race: D, book: book("381", [[0.6, 300]], [[0.65, 300]]) },
      { marketId: "382", race: R, book: book("382", [[0.45, 200]], [[0.5, 200]]) },
    ]);
    const a = arbs.find((x) => x.kind === "buy_all_no")!;
    expect(a).toBeDefined();
    expect(a.costPerSet).toBeCloseTo(0.4 + 0.55);
    expect(a.profitPerSet).toBeCloseTo(0.05);
    expect(a.quantity).toBe(200); // limited by the thinner leg
    expect(a.conditional).toBe(false);
  });

  it("flags buy-all-YES as conditional when a third party could win", () => {
    const arbs = detectArbitrage([
      { marketId: "381", race: D, book: book("381", [[0.4, 100]], [[0.45, 100]]) },
      { marketId: "382", race: R, book: book("382", [[0.4, 100]], [[0.5, 100]]) },
    ]);
    const a = arbs.find((x) => x.kind === "buy_all_yes")!;
    expect(a.conditional).toBe(true);
    expect(a.profitPerSet).toBeCloseTo(0.05);
  });

  it("detects a crossed single book", () => {
    const arbs = detectArbitrage([{ marketId: "381", race: D, book: book("381", [[0.6, 50]], [[0.55, 80]]) }]);
    expect(arbs[0].kind).toBe("crossed_book");
    expect(arbs[0].quantity).toBe(50);
  });
});
