import type { Action, Contract, Level, YesBook } from "./types";

export const TICK = 0.005;

export function round(n: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function normalizeBook(raw: {
  exchangeId: string;
  marketId: string;
  bids: Level[];
  asks: Level[];
  asOf?: string;
  topOnly?: boolean;
}): YesBook {
  const clean = (ls: Level[]) =>
    ls
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.quantity) && l.quantity > 0)
      .map((l) => ({ price: round(l.price), quantity: l.quantity }));
  return {
    exchangeId: raw.exchangeId,
    marketId: raw.marketId,
    bids: clean(raw.bids).sort((a, b) => b.price - a.price),
    asks: clean(raw.asks).sort((a, b) => a.price - b.price),
    asOf: raw.asOf ?? new Date().toISOString(),
    topOnly: raw.topOnly,
  };
}

export function contractOf(action: Action): Contract {
  return action.endsWith("YES") ? "YES" : "NO";
}

export function isBuy(action: Action): boolean {
  return action.startsWith("BUY");
}

/** Complement action with identical economics when a SELL is unbacked. */
export function complementOf(action: Action): Action {
  switch (action) {
    case "SELL_YES":
      return "BUY_NO";
    case "SELL_NO":
      return "BUY_YES";
    case "BUY_NO":
      return "SELL_YES";
    case "BUY_YES":
      return "SELL_NO";
  }
}

/**
 * Executable levels for an action, in the action's own contract terms, in fill order.
 *  BUY_YES  -> YES asks,  pay p
 *  SELL_YES -> YES bids,  receive p
 *  BUY_NO   -> YES bids,  pay 1 - p
 *  SELL_NO  -> YES asks,  receive 1 - p
 */
export function contractLevels(book: YesBook, action: Action): Level[] {
  switch (action) {
    case "BUY_YES":
      return book.asks.map((l) => ({ ...l }));
    case "SELL_YES":
      return book.bids.map((l) => ({ ...l }));
    case "BUY_NO":
      return book.bids.map((l) => ({ price: round(1 - l.price), quantity: l.quantity }));
    case "SELL_NO":
      return book.asks.map((l) => ({ price: round(1 - l.price), quantity: l.quantity }));
  }
}

export interface BookStats {
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  spreadPct: number | null;
  bidLiquidity: number;
  askLiquidity: number;
  imbalance: number | null; // (bid - ask) / (bid + ask), top 5 levels
}

export function bookStats(book: YesBook, depthLevels = 5): BookStats {
  const bestBid = book.bids[0]?.price ?? null;
  const bestAsk = book.asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null ? round((bestBid + bestAsk) / 2) : null;
  const spread = bestBid !== null && bestAsk !== null ? round(bestAsk - bestBid) : null;
  const bidLiquidity = book.bids.slice(0, depthLevels).reduce((s, l) => s + l.quantity, 0);
  const askLiquidity = book.asks.slice(0, depthLevels).reduce((s, l) => s + l.quantity, 0);
  const tot = bidLiquidity + askLiquidity;
  return {
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadPct: spread !== null && mid ? round(spread / mid) : null,
    bidLiquidity,
    askLiquidity,
    imbalance: tot > 0 ? round((bidLiquidity - askLiquidity) / tot) : null,
  };
}

/** Mid of the action's contract (YES mid, or 1 - YES mid for NO). */
export function contractMid(book: YesBook, contract: Contract): number | null {
  const { mid, bestBid, bestAsk } = bookStats(book);
  let yesMid = mid;
  // One-sided book: fall back to the only side we have (conservative for the trader).
  if (yesMid === null) yesMid = bestBid ?? bestAsk;
  if (yesMid === null) return null;
  return contract === "YES" ? yesMid : round(1 - yesMid);
}

export interface Execution {
  requested: number;
  filled: number;
  vwap: number | null; // contract terms
  bestPrice: number | null;
  worstPrice: number | null;
  slippage: number; // |vwap - best| per share
  notional: number;
  levelsUsed: number;
}

/**
 * Walk the book for `quantity` shares. Never assumes the whole size fills at the touch.
 * `limit` (contract terms) stops the walk at levels worse than the limit.
 */
export function simulateExecution(book: YesBook, action: Action, quantity: number, limit?: number | null): Execution {
  const levels = contractLevels(book, action);
  const buy = isBuy(action);
  let remaining = Math.max(0, Math.floor(quantity));
  let filled = 0;
  let notional = 0;
  let worst: number | null = null;
  let used = 0;
  for (const l of levels) {
    if (remaining <= 0) break;
    if (limit !== undefined && limit !== null) {
      if (buy && l.price > limit + 1e-9) break;
      if (!buy && l.price < limit - 1e-9) break;
    }
    const take = Math.min(remaining, l.quantity);
    filled += take;
    notional += take * l.price;
    remaining -= take;
    worst = l.price;
    used++;
  }
  const best = levels[0]?.price ?? null;
  const vwap = filled > 0 ? round(notional / filled) : null;
  return {
    requested: Math.floor(quantity),
    filled,
    vwap,
    bestPrice: best,
    worstPrice: worst,
    slippage: vwap !== null && best !== null ? round(Math.abs(vwap - best)) : 0,
    notional: round(notional, 4),
    levelsUsed: used,
  };
}

export function availableQuantity(book: YesBook, action: Action, limit?: number | null): number {
  return simulateExecution(book, action, Number.MAX_SAFE_INTEGER, limit).filled;
}

/** Remove executed quantity from a book copy (used by paper execution and backtests). */
export function consume(book: YesBook, action: Action, quantity: number): YesBook {
  const side: "bids" | "asks" = action === "BUY_YES" || action === "SELL_NO" ? "asks" : "bids";
  const levels = book[side].map((l) => ({ ...l }));
  let remaining = quantity;
  for (const l of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, l.quantity);
    l.quantity -= take;
    remaining -= take;
  }
  return { ...book, [side]: levels.filter((l) => l.quantity > 0) };
}

export function snapToTick(price: number, direction: "up" | "down" | "nearest" = "nearest"): number {
  const n = price / TICK;
  const k = direction === "up" ? Math.ceil(n - 1e-9) : direction === "down" ? Math.floor(n + 1e-9) : Math.round(n);
  return round(Math.min(0.995, Math.max(0.005, k * TICK)), 3);
}
