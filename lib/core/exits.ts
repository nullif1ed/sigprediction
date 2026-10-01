import type { Action, Position, YesBook } from "./types";
import { valuePosition } from "./portfolio";
import { availableQuantity, contractLevels, round, simulateExecution } from "./orderbook";

export interface ExitConfig {
  /**
   * Take profit once the executable exit beats entry by this many probability points per share.
   * Profit is measured on the VWAP of the shares actually sold, never on the touch alone.
   */
  takeProfitPp: number;
  /** legacy relative target (fraction of entry price); the smaller of the two targets applies */
  profitTarget: number;
  /** stop: adverse move of the reference price (mid) vs entry, in probability points */
  stopLossPp: number;
  /** legacy relative stop (fraction of entry price); the larger of the two stops applies */
  stopLoss: number;
  /** consecutive evaluations the stop condition must hold before selling (flash protection) */
  stopConfirmTicks: number;
  /**
   * Do not stop out while the executable exit is this far below our contract fair value: the book
   * is dislocated (liquidity pulled by other bots), and selling into it locks in the worst price.
   */
  dislocationPp: number;
  /** once this much real profit (pp) has been executable, a breakeven exit is armed */
  breakevenArmPp: number;
  /** a breakeven exit sells only at >= entry - this (pp); otherwise the normal stop applies */
  breakevenSlackPp: number;
  /** exit when exit price >= contract fair - buffer (and the sale is profitable) */
  fairValueBuffer: number;
  minDaysToResolution: number; // flatten when closer than this (0 disables)
  headlineMaxAgeMinutes: number; // time-decay exit for headline trades
  exitOnIlliquid: boolean;
  /** max probability points an exit may walk below the touch (limit-price protection) */
  maxExitSlippagePp: number;
}

// Tuned on the 1 Oct 2026 collected data (walk-forward, see PR notes).
export const DEFAULT_EXITS: ExitConfig = {
  takeProfitPp: 0.01,
  profitTarget: 0.02,
  stopLossPp: 0.04,
  stopLoss: 0.04,
  stopConfirmTicks: 2,
  dislocationPp: 0.08,
  breakevenArmPp: 0.015,
  breakevenSlackPp: 0.005,
  fairValueBuffer: 0.005,
  minDaysToResolution: 1,
  headlineMaxAgeMinutes: 60,
  exitOnIlliquid: false,
  maxExitSlippagePp: 0.02,
};

export interface ExitDecision {
  exit: boolean;
  reason: string;
  /** best executable exit price (contract terms) */
  exitPrice: number | null;
  /** IOC limit for the sale: never sell below this (contract terms) */
  limitPrice?: number;
  /** shares to sell (may be less than the position: scale out at the target) */
  quantity?: number;
}

/** Per-position state the exit logic carries between ticks (persisted on the Position). */
export interface ExitState {
  peakProfitPp?: number;
  stopStrikes?: number;
}

const sellAction = (p: Position): Action => (p.contract === "YES" ? "SELL_YES" : "SELL_NO");

/** Shares sellable at or above `limit`, and their VWAP. */
function sellableAt(book: YesBook, p: Position, qty: number, limit: number) {
  const ex = simulateExecution(book, sellAction(p), qty, limit);
  return { qty: ex.filled, vwap: ex.vwap };
}

/**
 * Exit rules, evaluated on what can actually be executed:
 *  1. take profit: sell every share that can be sold at >= entry + target (scale out as depth allows),
 *  2. fair value reached (profitable part only),
 *  3. stop loss on the mid move, confirmed over several ticks and suspended while the book is
 *     dislocated far below fair value; the sale itself is limit-protected,
 *  4. breakeven stop once the position has been in real profit,
 *  5. near resolution / headline time decay / illiquidity.
 * `qty` is the quantity this exit logic manages (positions shared with arbitrage legs pass only
 * the regular part).
 */
export function shouldExit(args: {
  position: Position & ExitState;
  book: YesBook | undefined;
  contractFair: number | null;
  daysToResolution: number;
  now: Date;
  cfg?: ExitConfig;
  qty?: number;
}): ExitDecision {
  const cfg = { ...DEFAULT_EXITS, ...(args.cfg ?? {}) };
  const p = args.position;
  const qty = Math.min(p.quantity, args.qty ?? p.quantity);
  if (!args.book || qty <= 0) return { exit: false, reason: "no_book", exitPrice: null };
  const v = valuePosition(p, args.book);
  if (v.exitPrice === null) return { exit: false, reason: "no_exit_liquidity", exitPrice: null };
  const entry = p.avgEntry;
  const best = v.exitPrice;
  const floor = (px: number) => round(Math.max(0.005, px), 4);

  // Real profit available right now at the touch, tracked for the breakeven stop.
  const touchProfit = best - entry;
  p.peakProfitPp = Math.max(p.peakProfitPp ?? -Infinity, touchProfit);

  // 1. Take profit: the smaller of the absolute and relative targets; sell what clears it.
  const target = Math.min(cfg.takeProfitPp, cfg.profitTarget * Math.max(0.005, entry));
  const tpPrice = entry + target;
  if (best >= tpPrice - 1e-9) {
    const s = sellableAt(args.book, p, qty, tpPrice);
    if (s.qty > 0) return { exit: true, reason: "profit_target", exitPrice: best, limitPrice: floor(tpPrice), quantity: s.qty };
  }

  // 2. Fair value reached: sell the part that is both near fair and profitable.
  if (args.contractFair !== null && best >= args.contractFair - cfg.fairValueBuffer && best > entry) {
    const lim = Math.max(entry + 0.001, args.contractFair - cfg.fairValueBuffer - cfg.maxExitSlippagePp);
    const s = sellableAt(args.book, p, qty, lim);
    if (s.qty > 0) return { exit: true, reason: "fair_value_reached", exitPrice: best, limitPrice: floor(lim), quantity: s.qty };
  }

  // 3. Breakeven: once real profit was executable, never let the position turn into a loss
  // without trying to get out flat. Only sells at (about) entry; otherwise the normal stop applies.
  const markPrice = v.markPrice;
  const armed = (p.peakProfitPp ?? -Infinity) >= cfg.breakevenArmPp;
  if (armed && markPrice <= entry + 1e-9) {
    const lim = floor(entry - cfg.breakevenSlackPp);
    const s = sellableAt(args.book, p, qty, lim);
    if (s.qty > 0) return { exit: true, reason: "breakeven_stop", exitPrice: best, limitPrice: lim, quantity: s.qty };
  }

  // 4. Stop loss on the contract mid (a pulled bid alone is not a move), confirmed over several
  // ticks, suspended while the book is dislocated far below fair value, and limit-protected.
  // Reference is the mid right after entry, so the half spread paid on entry is not a "loss".
  const refMid = p.entryLiquidationValue !== null && p.entryLiquidationValue !== undefined ? Math.min(entry, (entry + p.entryLiquidationValue) / 2) : entry;
  const stopDist = Math.max(cfg.stopLossPp, cfg.stopLoss * Math.max(0.005, entry));
  const stopLevel = refMid - stopDist;
  const breached = markPrice <= stopLevel + 1e-9;
  const dislocated = args.contractFair !== null && best < args.contractFair - cfg.dislocationPp;
  if (breached && !dislocated) {
    p.stopStrikes = (p.stopStrikes ?? 0) + 1;
    if (p.stopStrikes >= cfg.stopConfirmTicks) {
      const lim = floor(best - cfg.maxExitSlippagePp);
      const s = sellableAt(args.book, p, qty, lim);
      if (s.qty > 0) return { exit: true, reason: "stop_loss", exitPrice: best, limitPrice: lim, quantity: s.qty };
    }
  } else p.stopStrikes = 0;

  if (cfg.minDaysToResolution > 0 && args.daysToResolution <= cfg.minDaysToResolution)
    return { exit: true, reason: "near_resolution", exitPrice: best, limitPrice: floor(best - cfg.maxExitSlippagePp), quantity: qty };
  if (p.tradeType === "headline") {
    const age = (args.now.getTime() - Date.parse(p.openedAt)) / 60000;
    if (age >= cfg.headlineMaxAgeMinutes) return { exit: true, reason: "headline_time_decay", exitPrice: best, limitPrice: floor(best - cfg.maxExitSlippagePp), quantity: qty };
  }
  if (cfg.exitOnIlliquid && availableQuantity(args.book, sellAction(p)) < qty * 0.5)
    return { exit: true, reason: "insufficient_liquidity", exitPrice: best, limitPrice: floor(best - cfg.maxExitSlippagePp), quantity: qty };
  return { exit: false, reason: "hold", exitPrice: best };
}

/**
 * Unwind size for a held arbitrage set: sell every leg while the MARGINAL proceeds of one more set
 * (sum of the current bid-side level prices of each leg) stay >= `minProceedsPerSet`.
 */
export function sizeUnwind(legs: { marketId: string; action: Action; book: YesBook; held: number }[], minProceedsPerSet: number) {
  const ladders = legs.map((l) => contractLevels(l.book, l.action).map((x) => ({ ...x })));
  if (!ladders.length || ladders.some((x) => !x.length)) return null;
  const idx = ladders.map(() => 0);
  const proceeds = ladders.map(() => 0);
  const worst = ladders.map(() => 1);
  const maxQ = Math.min(...legs.map((l) => l.held));
  let q = 0;
  for (;;) {
    if (q >= maxQ || idx.some((i, k) => i >= ladders[k].length)) break;
    const marginal = ladders.reduce((s, lv, k) => s + lv[idx[k]].price, 0);
    if (marginal < minProceedsPerSet - 1e-12) break;
    const chunk = Math.min(maxQ - q, ...ladders.map((lv, k) => lv[idx[k]].quantity));
    if (chunk <= 0) break;
    for (let k = 0; k < ladders.length; k++) {
      const lv = ladders[k][idx[k]];
      proceeds[k] += chunk * lv.price;
      worst[k] = Math.min(worst[k], lv.price);
      lv.quantity -= chunk;
      if (lv.quantity <= 0) idx[k]++;
    }
    q += chunk;
  }
  if (q <= 0) return null;
  return { q, proceeds: proceeds.reduce((a, b) => a + b, 0), legs: legs.map((l, k) => ({ marketId: l.marketId, action: l.action, price: round(proceeds[k] / q), limit: worst[k] })) };
}
