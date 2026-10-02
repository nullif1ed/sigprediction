// Core domain types. Pure data, no I/O.
//
// Platform mechanics (from the Super Market API reference):
// - Every SIG market is a single binary exchange whose book is quoted in YES terms.
// - The NO side is derived: NO ask = 1 - YES bid, NO bid = 1 - YES ask.
// - BUY YES lifts YES asks. SELL YES hits YES bids.
// - BUY NO hits YES bids (pays 1 - bid). SELL NO lifts YES asks (receives 1 - ask).
// - A SELL that is unbacked (flat, opposite side, or larger than holdings) is canonicalised
//   by the engine into its complement BUY: `sell yes q@p` == `buy no q@(1-p)`.
// - Opposite-signed BUYs net against existing positions (FIFO lots).
// The four actions are tracked separately (labels, logs, orders), but their economics follow
// the platform rules above.

export type Action = "BUY_YES" | "SELL_YES" | "BUY_NO" | "SELL_NO";
export const ACTIONS: Action[] = ["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"];
export type Contract = "YES" | "NO";

export interface Level {
  price: number; // YES-denominated price in [0, 1]
  quantity: number;
}

/** Normalized YES order book. bids sorted desc, asks sorted asc. */
export interface YesBook {
  exchangeId: string;
  marketId: string;
  bids: Level[];
  asks: Level[];
  asOf: string; // ISO timestamp
  /** true when only top-of-book is known (quantities may be estimates) */
  topOnly?: boolean;
}

export type Party = "D" | "R" | "I";
export type Office = "SENATE" | "GOVERNOR" | "HOUSE" | "HOUSE_CONTROL" | "SENATE_CONTROL";

export interface RaceKey {
  party: Party;
  office: Office;
  /** USPS state code, e.g. "NH". "US" for chamber control markets. */
  state: string;
  /** House district number (1-based), only for HOUSE */
  district?: number;
  cycle: number; // election year, 2026
}

export interface SigMarket {
  id: string;
  exchangeId: string;
  title: string;
  status: string;
  settlementDate: string;
  categories: string[];
  race: RaceKey | null;
  latestPrice: number | null;
}

export interface Quote {
  bid: number | null;
  ask: number | null;
  bidQty?: number | null;
  askQty?: number | null;
}

export type Venue = "polymarket" | "kalshi";

export interface ExternalQuote {
  venue: Venue;
  externalId: string; // market slug / ticker
  question: string;
  /** YES-outcome quote for the matched party */
  bid: number | null;
  ask: number | null;
  last: number | null;
  mid: number | null;
  volume: number | null;
  liquidity: number | null;
  url: string;
  /** "equivalent" = same race, party, cycle; "near" = same event, criteria wording differs */
  matchQuality: "equivalent" | "near";
  criteriaNote: string;
  fetchedAt: string;
}

export interface NewsHeadline {
  id: string; // stable hash of url+title
  marketId: string;
  url: string;
  title: string;
  source: string;
  summary: string;
  publishedDate: string;
  relevanceExplanation: string;
  firstSeenAt: string;
}

export interface HeadlineImpact {
  direction: "bullish" | "bearish" | "neutral";
  /** signed shift to YES probability, capped */
  shift: number;
  confidence: number;
  credibility: number;
  sentiment: number; // [-1, 1]
}

export interface FairValueInput {
  marketId: string;
  sigQuote: Quote;
  external: ExternalQuote[];
  headlines: { headline: NewsHeadline; impact: HeadlineImpact; ageMinutes: number }[];
  imbalance: number | null; // [-1, 1] positive = bid pressure
  momentum: number | null; // recent mid change
  /** complementary market's mid (same race, other major party), if known */
  complementMid: number | null;
  daysToResolution: number;
}

export interface FairValueEstimate {
  marketId: string;
  fairProbability: number;
  confidence: number; // [0, 1] confidence in the estimate, NOT the probability
  lowerBound: number;
  upperBound: number;
  components: { source: string; value: number; weight: number }[];
  reasoning: string;
}

export type OpportunityType = "regular" | "headline" | "arbitrage";

export interface Opportunity {
  marketId: string;
  title: string;
  action: Action;
  contract: Contract;
  opportunityType: OpportunityType;
  /** per-share executable price for this action in its own contract terms */
  executablePrice: number;
  /** VWAP for the evaluated quantity in contract terms */
  vwap: number;
  bestPrice: number;
  fairValue: number; // fair value of the contract bought (YES fair or 1 - YES fair)
  grossEdge: number; // fair - mid (contract terms)
  spreadCost: number; // best - mid (half spread)
  slippage: number; // vwap - best
  transactionCosts: number; // 0 on SIG (no fees)
  netEdge: number; // fair - vwap
  expectedReturn: number; // netEdge / vwap
  confidence: number;
  availableQuantity: number;
  evaluatedQuantity: number;
  maxLossPerShare: number;
  riskAdjustedScore: number;
  /** actions with identical economics on SIG (e.g. SELL_YES vs BUY_NO when flat) */
  equivalentTo: Action[];
  closesPosition: boolean;
  headline?: { id: string; title: string; source: string; shift: number };
  reason: string;
}

export interface Decision extends Opportunity {
  quantity: number;
  estimatedCost: number;
  sizingStrategy: SizingStrategyName;
  scenario: string;
  portfolioExposureAfter: number;
  rejected?: string;
  timestamp: string;
}

export type SizingStrategyName = "fixed_fractional" | "volatility_adjusted" | "fractional_kelly";
export const SIZING_STRATEGIES: SizingStrategyName[] = ["fixed_fractional", "volatility_adjusted", "fractional_kelly"];

export type OrderStatus = "pending" | "partially_filled" | "filled" | "cancelled" | "expired" | "rejected";

export interface PaperOrder {
  orderId: string;
  marketId: string;
  action: Action;
  contract: Contract;
  orderType: "market" | "limit";
  limitPrice: number | null; // contract terms
  requestedQuantity: number;
  filledQuantity: number;
  fillPrice: number | null; // average, contract terms
  fees: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  notes: string;
  tag?: string; // decision reason / trade type
  /** orders that must execute together (an arbitrage set or unwind) share a group id */
  group?: string;
  /** worst level price walked by the simulated fill (contract terms): the live limit */
  worstPrice?: number | null;
}

export interface Fill {
  orderId: string;
  marketId: string;
  action: Action;
  quantity: number;
  price: number; // contract terms
  yesPrice: number; // YES-denominated execution price
  timestamp: string;
  realizedPnl: number;
}

export interface Lot {
  quantity: number;
  price: number;
}

export interface Position {
  marketId: string;
  contract: Contract;
  quantity: number;
  avgEntry: number;
  lots: Lot[];
  openedAt: string;
  entryFair: number | null;
  entryLiquidationValue: number | null; // exit price available right after entry
  tradeType: OpportunityType;
  realizedPnl: number;
}
