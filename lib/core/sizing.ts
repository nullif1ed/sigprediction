import type { Opportunity, SizingStrategyName } from "./types";

export interface RiskConfig {
  fixedFraction: number; // fraction of equity committed per trade (fixed fractional)
  volBaseFraction: number; // base fraction for volatility-adjusted sizing
  volTarget: number; // target per-share uncertainty (probability points)
  kellyFraction: number; // multiplier on full Kelly
  maxPositionPct: number; // max cost basis per market / equity
  maxRacePct: number; // max cost basis per race (correlated D/R markets) / equity
  maxGrossExposurePct: number; // max total cost basis / equity
  maxDrawdown: number; // stop opening new risk beyond this drawdown
  minQuantity: number;
  headlineMultiplier: number; // size boost for time-sensitive headline trades
}

export const DEFAULT_RISK: RiskConfig = {
  fixedFraction: 0.01,
  volBaseFraction: 0.01,
  volTarget: 0.03,
  kellyFraction: 0.25,
  maxPositionPct: 0.05,
  maxRacePct: 0.08,
  maxGrossExposurePct: 0.8,
  maxDrawdown: 0.2,
  minQuantity: 10,
  headlineMultiplier: 1.5,
};

export interface PortfolioView {
  equity: number;
  cash: number;
  grossExposure: number; // sum of cost basis
  drawdown: number; // current drawdown from peak, [0, 1]
  marketExposure: (marketId: string) => number;
  raceExposure: (marketId: string) => number;
}

/** Full-Kelly fraction for buying a binary contract at price c with win probability p. */
export function kelly(p: number, c: number): number {
  if (c <= 0 || c >= 1) return 0;
  return Math.max(0, (p - c) / (1 - c));
}

export function sdOf(o: Opportunity, fairSd: number): number {
  return Math.max(0.005, fairSd);
}

/** Raw (unconstrained) notional suggested by a sizing strategy. */
export function rawNotional(
  strategy: SizingStrategyName,
  o: Opportunity,
  equity: number,
  fairSd: number,
  r: RiskConfig = DEFAULT_RISK,
): number {
  const price = o.vwap;
  switch (strategy) {
    case "fixed_fractional":
      return equity * r.fixedFraction;
    case "volatility_adjusted": {
      const scale = Math.min(3, Math.max(0.25, r.volTarget / sdOf(o, fairSd)));
      return equity * r.volBaseFraction * scale;
    }
    case "fractional_kelly": {
      // Shrink the edge toward zero by confidence before applying Kelly.
      const pAdj = price + (o.fairValue - price) * o.confidence;
      return equity * r.kellyFraction * kelly(pAdj, price);
    }
  }
}

export interface SizeResult {
  quantity: number;
  notional: number;
  limitedBy: string;
}

/** Apply every hard limit. Never returns a size that breaks a risk limit or available cash. */
export function constrainSize(
  o: Opportunity,
  notional: number,
  pf: PortfolioView,
  r: RiskConfig = DEFAULT_RISK,
): SizeResult {
  if (o.closesPosition) {
    // Closing trades reduce risk; size is bounded by holdings and liquidity only.
    const q = Math.min(o.evaluatedQuantity, o.availableQuantity);
    return { quantity: q, notional: q * o.vwap, limitedBy: "holdings" };
  }
  if (pf.drawdown >= r.maxDrawdown) return { quantity: 0, notional: 0, limitedBy: "max_drawdown" };
  const price = Math.max(0.005, o.vwap);
  const caps: [string, number][] = [
    ["strategy", notional],
    ["cash", pf.cash],
    ["max_position", pf.equity * r.maxPositionPct - pf.marketExposure(o.marketId)],
    ["max_race", pf.equity * r.maxRacePct - pf.raceExposure(o.marketId)],
    ["max_gross", pf.equity * r.maxGrossExposurePct - pf.grossExposure],
    ["liquidity", o.availableQuantity * price],
  ];
  let [limitedBy, cap] = caps[0];
  for (const [k, v] of caps) if (v < cap) [limitedBy, cap] = [k, v];
  const q = Math.floor(Math.max(0, cap) / price);
  if (q < r.minQuantity) return { quantity: 0, notional: 0, limitedBy: q <= 0 ? limitedBy : "min_quantity" };
  return { quantity: q, notional: q * price, limitedBy };
}

/** Scenario bucket used to learn which sizing strategy works where. */
export function scenarioOf(o: Opportunity, daysToResolution: number): string {
  if (o.opportunityType !== "regular") return o.opportunityType;
  const edge = o.netEdge >= 0.03 ? "high_edge" : o.netEdge >= 0.01 ? "mid_edge" : "low_edge";
  const conf = o.confidence >= 0.75 ? "high_conf" : o.confidence >= 0.5 ? "mid_conf" : "low_conf";
  const liq = o.availableQuantity >= 1000 ? "deep" : "thin";
  const time = daysToResolution <= 3 ? "near_res" : "far_res";
  return `${edge}|${conf}|${liq}|${time}`;
}

export type ScenarioRules = Record<string, { strategy: SizingStrategyName; trades: number; avgPnl: number }>;

/** Default rules before any backtest has run. */
export function defaultStrategyFor(scenario: string): SizingStrategyName {
  if (scenario === "arbitrage") return "fixed_fractional";
  if (scenario === "headline") return "volatility_adjusted";
  if (scenario.startsWith("high_edge|high_conf|deep")) return "fractional_kelly";
  if (scenario.includes("low_conf") || scenario.includes("thin")) return "fixed_fractional";
  return "volatility_adjusted";
}

export function selectStrategy(scenario: string, rules: ScenarioRules | null, minTrades = 5): SizingStrategyName {
  const rule = rules?.[scenario];
  if (rule && rule.trades >= minTrades) return rule.strategy;
  return defaultStrategyFor(scenario);
}
