import { describe, expect, it } from "vitest";
import { discrepancy, kalshiQuote, polymarketQuote } from "@/lib/server/external";
import { parseSigTitle } from "@/lib/core/races";
import { fixture } from "./helpers";

const D = parseSigTitle("Will the Democratic Party win the New Hampshire Senate?")!;
const R = parseSigTitle("Will the Republican Party win the New Hampshire Senate?")!;

describe("external market matching", () => {
  const poly = new Map([["new-hampshire-senate-election-winner", fixture<{ slug: string; markets: never[] }>("polymarket-nh-senate.json") as never]]);
  const kal = fixture<{ markets?: unknown[]; event: { markets?: unknown[] } }>("kalshi-senatenh-26.json");
  const kmap = new Map([["SENATENH-26", (kal.markets?.length ? kal.markets : kal.event.markets) as never]]);

  it("matches the Polymarket market for the right party", () => {
    const d = polymarketQuote(D, poly)!;
    const r = polymarketQuote(R, poly)!;
    expect(d.question).toMatch(/Democrat/);
    expect(r.question).toMatch(/Republican/);
    expect(d.mid! + r.mid!).toBeGreaterThan(0.9);
    expect(d.matchQuality).toBe("equivalent");
  });

  it("matches Kalshi by party suffix", () => {
    const d = kalshiQuote(D, kmap)!;
    expect(d.externalId).toBe("SENATENH-26-D");
    expect(d.mid).toBeGreaterThan(0.5);
    expect(kalshiQuote(R, kmap)!.externalId).toBe("SENATENH-26-R");
  });

  it("refuses to match a different election cycle", () => {
    const old = { ...D, cycle: 2028 };
    expect(polymarketQuote(old, poly)).toBeNull();
    expect(kalshiQuote(old, kmap)).toBeNull();
  });

  it("computes discrepancy statistics", () => {
    const q = polymarketQuote(D, poly)!;
    const s = discrepancy(0.865, q, [0.01, 0.0, 0.02, 0.01])!;
    expect(s.priceDiff).toBeCloseTo(0.865 - q.mid!, 4);
    expect(s.zScore).not.toBeNull();
    expect(Math.abs(s.liquidityAdjustedDiff)).toBeLessThanOrEqual(Math.abs(s.priceDiff));
  });
});

describe("Kalshi batching", () => {
  it("fetches D/R markets in one batched request and independents per event", async () => {
    const { fetchKalshi } = await import("@/lib/server/external");
    const urls: string[] = [];
    const kal = fixture<{ markets: unknown[]; event: { markets: unknown[] } }>("kalshi-senatenh-26.json");
    const markets = kal.markets?.length ? kal.markets : kal.event.markets;
    const fetchFn = (async (u: string) => {
      urls.push(u);
      if (u.includes("/markets?tickers=")) return new Response(JSON.stringify({ markets }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const I = parseSigTitle("Will the Independent Party win the Nebraska Senate?")!;
    const m = await fetchKalshi([D, R, I], fetchFn);
    expect(urls.filter((u) => u.includes("tickers=")).length).toBe(1);
    expect(urls[0]).toContain("SENATENH-26-D");
    expect(urls.some((u) => u.includes("/events/SENATENE-26"))).toBe(true);
    expect(kalshiQuote(D, m)!.externalId).toBe("SENATENH-26-D");
  });
});
