import { ACTIONS, type Action, type FairValueEstimate, type Opportunity, type OpportunityType, type YesBook } from "./types";
import { availableQuantity, complementOf, contractMid, contractOf, isBuy, round, simulateExecution } from "./orderbook";

export interface Holdings {
  YES: number;
  NO: number;
}

export interface EvalParams {
  probeQuantity: number; // size used to estimate VWAP/slippage
  transactionCost: number; // per share; 0 on SIG (no fees in the simulated contest)
}
export const DEFAULT_EVAL: EvalParams = { probeQuantity: 500, transactionCost: 0 };

function contractFair(fair: FairValueEstimate, action: Action) {
  const yes = fair.fairProbability;
  const sdYes = (fair.upperBound - fair.lowerBound) / 3.92;
  return { fair: contractOf(action) === "YES" ? yes : 1 - yes, sd: Math.max(0.005, sdYes) };
}

export function riskAdjustedScore(o: {
  netEdge: number;
  vwap: number;
  confidence: number;
  sd: number;
  available: number;
  probe: number;
}): number {
  if (o.netEdge <= 0 || o.vwap <= 0) return 0;
  const ret = o.netEdge / o.vwap;
  const liq = Math.min(1, o.available / Math.max(1, o.probe));
  // Edge measured in standard deviations of our own fair-value uncertainty.
  const edgeZ = o.netEdge / o.sd;
  return round(100 * ret * o.confidence * liq * Math.min(1, edgeZ / 2), 3);
}

/**
 * Evaluate all four actions for one market. SIG semantics:
 *  - BUY_YES / BUY_NO open (or net against) positions.
 *  - SELL_X when holding X closes conventionally at the bid side of X.
 *  - SELL_X when not holding X is canonicalised to the complement BUY; we still report it,
 *    flagged `equivalentTo`, so the ranking never double counts one economic trade.
 */
export function evaluateMarket(args: {
  marketId: string;
  title: string;
  book: YesBook;
  fair: FairValueEstimate;
  holdings: Holdings;
  params?: EvalParams;
  type?: OpportunityType;
}): Opportunity[] {
  const p = args.params ?? DEFAULT_EVAL;
  const out: Opportunity[] = [];
  for (const action of ACTIONS) {
    const contract = contractOf(action);
    const buy = isBuy(action);
    const held = args.holdings[contract];
    const closes = !buy && held > 0;
    // Unbacked sell == complement buy: evaluate with the complement's economics.
    const econAction: Action = !buy && !closes ? complementOf(action) : action;
    const econContract = contractOf(econAction);
    const econBuy = isBuy(econAction);
    const probe = closes ? Math.min(held, p.probeQuantity) : p.probeQuantity;
    const ex = simulateExecution(args.book, econAction, probe);
    const mid = contractMid(args.book, econContract);
    if (ex.vwap === null || ex.bestPrice === null || mid === null) continue;
    const { fair, sd } = contractFair(args.fair, econAction);

    // Edge is always "fair value of what we end up holding minus what we pay",
    // or for a closing sale "what we receive minus the fair value we give up".
    const netEdge = econBuy ? fair - ex.vwap - p.transactionCost : ex.vwap - fair - p.transactionCost;
    const grossEdge = econBuy ? fair - mid : mid - fair;
    const spreadCost = Math.abs(ex.bestPrice - mid);
    const avail = availableQuantity(args.book, econAction);
    const score = riskAdjustedScore({
      netEdge,
      vwap: econBuy ? ex.vwap : Math.max(0.005, fair),
      confidence: args.fair.confidence,
      sd,
      available: avail,
      probe,
    });
    const equivalentTo: Action[] = !buy && !closes ? [econAction] : buy && args.holdings[contract === "YES" ? "NO" : "YES"] === 0 ? [complementOf(action)] : [];
    out.push({
      marketId: args.marketId,
      title: args.title,
      action,
      contract,
      opportunityType: args.type ?? "regular",
      executablePrice: ex.bestPrice,
      vwap: ex.vwap,
      bestPrice: ex.bestPrice,
      fairValue: round(fair, 4),
      grossEdge: round(grossEdge, 4),
      spreadCost: round(spreadCost, 4),
      slippage: round(ex.slippage, 4),
      transactionCosts: p.transactionCost,
      netEdge: round(netEdge, 4),
      expectedReturn: round(econBuy ? netEdge / ex.vwap : netEdge / Math.max(0.005, fair), 4),
      confidence: args.fair.confidence,
      availableQuantity: avail,
      evaluatedQuantity: ex.filled,
      maxLossPerShare: econBuy ? ex.vwap : round(1 - ex.vwap, 4),
      riskAdjustedScore: score,
      equivalentTo,
      closesPosition: closes,
      reason: describe(action, econAction, closes, ex.vwap, fair, netEdge, args.fair),
    });
  }
  return out;
}

function describe(action: Action, econ: Action, closes: boolean, vwap: number, fair: number, net: number, fv: FairValueEstimate) {
  const leg = closes
    ? `${action} closes held shares at VWAP ${vwap.toFixed(3)}`
    : action === econ
      ? `${action} at VWAP ${vwap.toFixed(3)}`
      : `${action} is unbacked, so SIG fills it as ${econ} at ${vwap.toFixed(3)}`;
  return `${leg}; contract fair ${fair.toFixed(3)} (conf ${fv.confidence.toFixed(2)}); net edge ${(net * 100).toFixed(2)}pp. ${fv.reasoning}`;
}

/** Keep only economically distinct, positive-edge opportunities, best first. */
export function rankOpportunities(opps: Opportunity[], minNetEdge = 0.01, minConfidence = 0.35): Opportunity[] {
  const seen = new Set<string>();
  const ranked = opps
    .filter((o) => o.netEdge >= minNetEdge && o.confidence >= minConfidence && o.riskAdjustedScore > 0)
    .sort((a, b) => {
      const pri = (o: Opportunity) => (o.opportunityType === "arbitrage" ? 2 : o.opportunityType === "headline" ? 1 : 0);
      // Equal economics: prefer the canonical BUY label over an unbacked SELL.
      const unbacked = (o: Opportunity) => (!o.action.startsWith("BUY") && !o.closesPosition ? 1 : 0);
      return pri(b) - pri(a) || b.riskAdjustedScore - a.riskAdjustedScore || unbacked(a) - unbacked(b);
    });
  return ranked.filter((o) => {
    // An unbacked SELL and its complement BUY are the same trade: keep the first one seen.
    const econ = o.closesPosition ? `close:${o.action}` : o.equivalentTo.length && !o.action.startsWith("BUY") ? o.equivalentTo[0] : o.action;
    const k = `${o.marketId}:${econ}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
