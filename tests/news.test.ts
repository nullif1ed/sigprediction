import { describe, expect, it } from "vitest";
import { headlineImpact, headlineSentiment, newsTilt, sourceCredibility } from "@/lib/core/news";
import { fixture } from "./helpers";
import type { NewsHeadline } from "@/lib/core/types";

type Raw = { headlines: Omit<NewsHeadline, "id" | "marketId" | "firstSeenAt">[] };
const toH = (m: string, r: Raw): NewsHeadline[] => r.headlines.map((h, i) => ({ ...h, id: String(i), marketId: m, firstSeenAt: "2026-09-30T00:00:00Z" }));

describe("headline analysis", () => {
  it("reads market-relative explanations in the right direction", () => {
    const dem = toH("381", fixture<Raw>("sig-news-381.json"));
    const rep = toH("382", fixture<Raw>("sig-news-382.json"));
    expect(newsTilt(dem)).toBeGreaterThan(0); // news favours the Democratic NH Senate market
    expect(newsTilt(rep)).toBeLessThan(0); // and is negative for the Republican one
  });

  it("does not count 'lowers the likelihood' as positive", () => {
    const s = headlineSentiment({ title: "", summary: "", relevanceExplanation: "Republicans are trailing, which lowers the probability of a GOP win." });
    expect(s).toBeLessThan(0);
  });

  it("weights credible sources and decays with age", () => {
    expect(sourceCredibility("The New York Times")).toBeGreaterThan(sourceCredibility("Yahoo News"));
    const h = toH("381", fixture<Raw>("sig-news-381.json"))[0];
    const fresh = headlineImpact(h, 0);
    const old = headlineImpact(h, 600);
    expect(Math.abs(fresh.shift)).toBeGreaterThan(Math.abs(old.shift));
    expect(Math.abs(fresh.shift)).toBeLessThanOrEqual(0.06);
  });
});
