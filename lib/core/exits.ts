import type { Position, YesBook } from "./types";
import { valuePosition } from "./portfolio";
import { availableQuantity } from "./orderbook";

export interface ExitConfig {
  profitTarget: number; // fraction of entry price
  stopLoss: number; // fraction of entry price
  fairValueBuffer: number; // exit when exit price >= contract fair - buffer
  minDaysToResolution: number; // flatten when closer than this (0 disables)
  headlineMaxAgeMinutes: number; // time-decay exit for headline trades
  exitOnIlliquid: boolean;
}

// Pre-Day-1 defaults. These are the first parameters to sweep in backtests.
export const DEFAULT_EXITS: ExitConfig = {
  profitTarget: 0.02,
  stopLoss: 0.02,
  fairValueBuffer: 0.005,
  minDaysToResolution: 1,
  headlineMaxAgeMinutes: 60,
  exitOnIlliquid: false,
};

export interface ExitDecision {
  exit: boolean;
  reason: string;
  exitPrice: number | null;
}

/**
 * Stop loss is move-based: measured against the exit price available right after entry, so the
 * spread paid on entry does not instantly trigger the stop on wide SIG books (an 8-point spread
 * would otherwise read as a -9% loss the moment a trade fills). Profit target uses real profit at
 * the executable exit price, so it never "takes profit" at a loss.
 */
export function shouldExit(args: {
  position: Position;
  book: YesBook | undefined;
  contractFair: number | null;
  daysToResolution: number;
  now: Date;
  cfg?: ExitConfig;
}): ExitDecision {
  const cfg = args.cfg ?? DEFAULT_EXITS;
  const p = args.position;
  if (!args.book) return { exit: false, reason: "no_book", exitPrice: null };
  const v = valuePosition(p, args.book);
  if (v.exitPrice === null) return { exit: false, reason: "no_exit_liquidity", exitPrice: null };
  const ref = p.entryLiquidationValue ?? p.avgEntry;
  const move = (v.exitPrice - ref) / Math.max(0.005, p.avgEntry);

  // Take profit only on real profit at the executable exit; stops use the post-entry move.
  if ((v.exitPrice - p.avgEntry) / Math.max(0.005, p.avgEntry) >= cfg.profitTarget)
    return { exit: true, reason: "profit_target", exitPrice: v.exitPrice };
  if (move <= -cfg.stopLoss) return { exit: true, reason: "stop_loss", exitPrice: v.exitPrice };
  if (args.contractFair !== null && v.exitPrice >= args.contractFair - cfg.fairValueBuffer && v.exitPrice > p.avgEntry)
    return { exit: true, reason: "fair_value_reached", exitPrice: v.exitPrice };
  if (cfg.minDaysToResolution > 0 && args.daysToResolution <= cfg.minDaysToResolution)
    return { exit: true, reason: "near_resolution", exitPrice: v.exitPrice };
  if (p.tradeType === "headline") {
    const age = (args.now.getTime() - Date.parse(p.openedAt)) / 60000;
    if (age >= cfg.headlineMaxAgeMinutes) return { exit: true, reason: "headline_time_decay", exitPrice: v.exitPrice };
  }
  if (cfg.exitOnIlliquid) {
    const action = p.contract === "YES" ? "SELL_YES" : "SELL_NO";
    if (availableQuantity(args.book, action) < p.quantity * 0.5) return { exit: true, reason: "insufficient_liquidity", exitPrice: v.exitPrice };
  }
  return { exit: false, reason: "hold", exitPrice: v.exitPrice };
}
