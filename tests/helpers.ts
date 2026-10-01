import fs from "node:fs";
import path from "node:path";
import { normalizeBook } from "@/lib/core/orderbook";
import type { FairValueEstimate, YesBook } from "@/lib/core/types";

export const fixture = <T = unknown>(name: string): T => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8")) as T;

export function book(marketId: string, bids: [number, number][], asks: [number, number][], asOf = "v1"): YesBook {
  return normalizeBook({
    exchangeId: `ex-${marketId}`,
    marketId,
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    asks: asks.map(([price, quantity]) => ({ price, quantity })),
    asOf,
  });
}

export function fair(marketId: string, p: number, confidence = 0.8, sd = 0.02): FairValueEstimate {
  return { marketId, fairProbability: p, confidence, lowerBound: p - 1.96 * sd, upperBound: p + 1.96 * sd, components: [], reasoning: "test" };
}
