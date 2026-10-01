import { round } from "./orderbook";

export interface EquityPoint {
  t: string;
  equity: number;
  exposure?: number;
}

export interface TradeResult {
  pnl: number;
}

export interface PerformanceMetrics {
  startingCapital: number;
  endingCapital: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  winRate: number | null;
  profitFactor: number | null;
  averageTrade: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  numTrades: number;
  numClosedTrades: number;
  turnover: number; // traded notional / starting capital
  maxExposure: number; // peak cost basis / equity
  capitalUtilization: number; // mean cost basis / equity
}

function returns(curve: EquityPoint[]): { r: number[]; dtSec: number } {
  const r: number[] = [];
  const dts: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1].equity;
    if (a > 0) r.push(curve[i].equity / a - 1);
    dts.push((Date.parse(curve[i].t) - Date.parse(curve[i - 1].t)) / 1000);
  }
  dts.sort((x, y) => x - y);
  return { r, dtSec: dts.length ? Math.max(1, dts[Math.floor(dts.length / 2)]) : 1 };
}

const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;

/** Annualised Sharpe / Sortino from snapshot-interval returns. */
export function sharpe(curve: EquityPoint[]): { sharpe: number | null; sortino: number | null } {
  const { r, dtSec } = returns(curve);
  // Annualising a handful of 5-second returns produces meaningless numbers; require a real sample.
  const spanSec = curve.length > 1 ? (Date.parse(curve[curve.length - 1].t) - Date.parse(curve[0].t)) / 1000 : 0;
  if (r.length < 20 || spanSec < 3600) return { sharpe: null, sortino: null };
  const m = mean(r);
  const sd = Math.sqrt(mean(r.map((v) => (v - m) ** 2)));
  const down = r.filter((v) => v < 0);
  const dsd = down.length ? Math.sqrt(down.reduce((s, v) => s + v * v, 0) / r.length) : 0;
  const ann = Math.sqrt((365 * 86400) / dtSec);
  return {
    sharpe: sd > 0 ? round((m / sd) * ann, 3) : null,
    sortino: dsd > 0 ? round((m / dsd) * ann, 3) : null,
  };
}

export function maxDrawdown(curve: EquityPoint[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) mdd = Math.max(mdd, (peak - p.equity) / peak);
  }
  return round(mdd, 5);
}

export function computeMetrics(args: {
  startingCapital: number;
  curve: EquityPoint[];
  closedTrades: TradeResult[];
  numTrades: number;
  tradedNotional: number;
}): PerformanceMetrics {
  const end = args.curve.length ? args.curve[args.curve.length - 1].equity : args.startingCapital;
  const wins = args.closedTrades.filter((t) => t.pnl > 0);
  const losses = args.closedTrades.filter((t) => t.pnl < 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = -losses.reduce((s, t) => s + t.pnl, 0);
  const exp = args.curve.map((p) => (p.equity > 0 ? (p.exposure ?? 0) / p.equity : 0));
  const sr = sharpe(args.curve);
  const n = args.closedTrades.length;
  return {
    startingCapital: args.startingCapital,
    endingCapital: round(end, 2),
    totalReturn: round(end / args.startingCapital - 1, 5),
    maxDrawdown: maxDrawdown(args.curve),
    sharpeRatio: sr.sharpe,
    sortinoRatio: sr.sortino,
    winRate: n ? round(wins.length / n, 4) : null,
    profitFactor: gl > 0 ? round(gw / gl, 3) : gw > 0 ? null : null,
    averageTrade: n ? round((gw - gl) / n, 2) : null,
    avgWin: wins.length ? round(gw / wins.length, 2) : null,
    avgLoss: losses.length ? round(-gl / losses.length, 2) : null,
    numTrades: args.numTrades,
    numClosedTrades: n,
    turnover: round(args.tradedNotional / args.startingCapital, 4),
    maxExposure: exp.length ? round(Math.max(...exp), 4) : 0,
    capitalUtilization: exp.length ? round(mean(exp), 4) : 0,
  };
}

/** Composite score used to compare strategy variants (higher is better). */
export function strategyScore(m: PerformanceMetrics): number {
  return round(
    0.4 * (m.sharpeRatio ?? 0) - 0.25 * m.maxDrawdown * 10 + 0.15 * (m.winRate ?? 0) + 0.15 * m.capitalUtilization + 0.05 * Math.min(5, m.profitFactor ?? 0),
    4,
  );
}
