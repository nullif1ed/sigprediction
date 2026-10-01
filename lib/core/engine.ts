import type {
  Decision,
  ExternalQuote,
  FairValueEstimate,
  NewsHeadline,
  Opportunity,
  SigMarket,
  SizingStrategyName,
  YesBook,
} from "./types";
import { bookStats, contractMid, round } from "./orderbook";
import { DEFAULT_FAIR_VALUE, estimateFairValue, type FairValueParams } from "./fairValue";
import { DEFAULT_IMPACT, headlineImpact, type ImpactParams } from "./news";
import { DEFAULT_EVAL, evaluateMarket, rankOpportunities, type EvalParams } from "./opportunity";
import { detectArbitrage, sizeSet, type ArbitrageOpportunity } from "./arbitrage";
import { allocateArbitrage, type ArbCandidate } from "./arbAllocation";
import { constrainSize, DEFAULT_RISK, rawNotional, scenarioOf, selectStrategy, type RiskConfig, type ScenarioRules } from "./sizing";
import { DEFAULT_EXITS, shouldExit, type ExitConfig } from "./exits";
import type { Portfolio } from "./portfolio";
import type { PaperExecutionClient } from "./execution";
import { raceId } from "./races";

export interface StrategyConfig {
  name: string;
  description: string;
  fairValue: FairValueParams;
  eval: EvalParams;
  risk: RiskConfig;
  exits: ExitConfig;
  impact: ImpactParams;
  minNetEdge: number;
  minConfidence: number;
  headlineTrading: boolean;
  headlineWindowMinutes: number; // headlines newer than this are traded, not blended into fair value
  minHeadlineShift: number;
  arbitrage: boolean;
  maxNewTradesPerTick: number;
  /** "auto" picks a sizing strategy per scenario using backtest-learned rules */
  sizing: SizingStrategyName | "auto";
  basedOn?: string | null;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  name: "baseline",
  description: "Pre-Day-1 defaults: blended fair value, 1pp min net edge, auto sizing, 2%/2% exits.",
  fairValue: DEFAULT_FAIR_VALUE,
  eval: DEFAULT_EVAL,
  risk: DEFAULT_RISK,
  exits: DEFAULT_EXITS,
  impact: DEFAULT_IMPACT,
  minNetEdge: 0.01,
  minConfidence: 0.4,
  headlineTrading: true,
  headlineWindowMinutes: 120,
  minHeadlineShift: 0.01,
  arbitrage: true,
  maxNewTradesPerTick: 5,
  sizing: "auto",
};

export function mergeStrategy(partial: Partial<StrategyConfig> & { name?: string }): StrategyConfig {
  return {
    ...DEFAULT_STRATEGY,
    ...partial,
    fairValue: { ...DEFAULT_STRATEGY.fairValue, ...(partial.fairValue ?? {}) },
    eval: { ...DEFAULT_STRATEGY.eval, ...(partial.eval ?? {}) },
    risk: { ...DEFAULT_STRATEGY.risk, ...(partial.risk ?? {}) },
    exits: { ...DEFAULT_STRATEGY.exits, ...(partial.exits ?? {}) },
    impact: { ...DEFAULT_STRATEGY.impact, ...(partial.impact ?? {}) },
  };
}

/** Everything known at time `now`. Backtests build this only from records stamped <= now. */
export interface MarketState {
  now: Date;
  markets: SigMarket[];
  books: Map<string, YesBook>; // by marketId
  external: Map<string, ExternalQuote[]>;
  headlines: Map<string, NewsHeadline[]>;
  prevMids?: Map<string, number>;
}

export interface HeadlineSignal {
  marketId: string;
  headline: NewsHeadline;
  shift: number;
  confidence: number;
  ageMinutes: number;
}

export interface Signals {
  fair: Map<string, FairValueEstimate>;
  headlines: HeadlineSignal[];
  arbitrage: ArbitrageOpportunity[];
}

const daysTo = (iso: string, now: Date) => (Date.parse(iso) - now.getTime()) / 86_400_000;

export function computeSignals(state: MarketState, cfg: StrategyConfig): Signals {
  const fair = new Map<string, FairValueEstimate>();
  const headlineSignals: HeadlineSignal[] = [];
  const byRace = new Map<string, SigMarket[]>();
  for (const m of state.markets) if (m.race) byRace.set(raceId(m.race), [...(byRace.get(raceId(m.race)) ?? []), m]);

  for (const m of state.markets) {
    const book = state.books.get(m.id);
    if (!book) continue;
    const s = bookStats(book);
    const heads = state.headlines.get(m.id) ?? [];
    const fresh: HeadlineSignal[] = [];
    const settled: { headline: NewsHeadline; impact: ReturnType<typeof headlineImpact>; ageMinutes: number }[] = [];
    for (const h of heads) {
      const age = (state.now.getTime() - Date.parse(h.firstSeenAt)) / 60000;
      if (age < 0) continue; // not yet known at `now`
      const impact = headlineImpact(h, age, cfg.impact);
      if (cfg.headlineTrading && age <= cfg.headlineWindowMinutes) {
        fresh.push({ marketId: m.id, headline: h, shift: impact.shift, confidence: impact.confidence, ageMinutes: age });
      } else settled.push({ headline: h, impact, ageMinutes: age });
    }
    // Complement: the only other major party in a two-way race.
    let complementMid: number | null = null;
    if (m.race && (m.race.party === "D" || m.race.party === "R")) {
      const peers = (byRace.get(raceId(m.race)) ?? []).filter((x) => x.id !== m.id);
      const hasThird = peers.some((x) => x.race?.party === "I");
      const opp = peers.find((x) => x.race?.party === (m.race!.party === "D" ? "R" : "D"));
      const ob = opp ? state.books.get(opp.id) : undefined;
      if (opp && ob && !hasThird) complementMid = contractMid(ob, "YES");
    }
    const prev = state.prevMids?.get(m.id) ?? null;
    const est = estimateFairValue(
      {
        marketId: m.id,
        sigQuote: { bid: s.bestBid, ask: s.bestAsk },
        external: state.external.get(m.id) ?? [],
        headlines: settled,
        imbalance: s.imbalance,
        momentum: prev !== null && s.mid !== null ? s.mid - prev : null,
        complementMid,
        daysToResolution: daysTo(m.settlementDate, state.now),
      },
      cfg.fairValue,
    );
    if (!est) continue;
    fair.set(m.id, est);
    for (const f of fresh) if (Math.abs(f.shift) >= cfg.minHeadlineShift) headlineSignals.push(f);
  }

  const arbitrage = cfg.arbitrage
    ? detectArbitrage(
        state.markets
          .filter((m) => m.race && state.books.has(m.id))
          .map((m) => ({ marketId: m.id, race: m.race!, book: state.books.get(m.id)! })),
      )
    : [];
  return { fair, headlines: headlineSignals, arbitrage };
}

export interface TickResult {
  decisions: Decision[];
  exits: { marketId: string; contract: string; reason: string; quantity: number; price: number | null }[];
  evaluated: number;
  logs: { level: "INFO" | "WARNING" | "ERROR"; message: string; context?: Record<string, unknown> }[];
}

/**
 * One strategy step for one portfolio:
 * exits first, then arbitrage, then headline trades, then regular opportunities.
 */
export function runPortfolioTick(args: {
  state: MarketState;
  signals: Signals;
  cfg: StrategyConfig;
  portfolio: Portfolio;
  exec: PaperExecutionClient;
  sizingMode: SizingStrategyName | "auto";
  rules: ScenarioRules | null;
  tradedHeadlines: Set<string>;
  onDecision?: (d: Decision) => void;
  /** books used for fills (e.g. the book after simulated latency); defaults to state.books */
  execBooks?: Map<string, YesBook>;
}): TickResult {
  const { state, signals, cfg, portfolio, exec } = args;
  const out: TickResult = { decisions: [], exits: [], evaluated: 0, logs: [] };
  const titles = new Map(state.markets.map((m) => [m.id, m]));
  for (const b of (args.execBooks ?? state.books).values()) exec.updateBook(b);
  const ts = state.now.toISOString();

  // 1. Re-evaluate and exit existing positions.
  for (const p of portfolio.positions()) {
    // Arbitrage legs only lock in profit as a set held to settlement: never exit them individually.
    if (p.tradeType === "arbitrage") continue;
    const m = titles.get(p.marketId);
    const f = signals.fair.get(p.marketId);
    const contractFair = f ? (p.contract === "YES" ? f.fairProbability : 1 - f.fairProbability) : null;
    const ex = shouldExit({
      position: p,
      book: exec.book(p.marketId),
      contractFair,
      daysToResolution: m ? daysTo(m.settlementDate, state.now) : 99,
      now: state.now,
      cfg: cfg.exits,
    });
    if (!ex.exit) continue;
    const action = p.contract === "YES" ? "SELL_YES" : "SELL_NO";
    const qty = p.quantity;
    const o = exec.submitOrder({ marketId: p.marketId, action, quantity: qty, orderType: "market", tag: `exit:${ex.reason}` });
    out.exits.push({ marketId: p.marketId, contract: p.contract, reason: ex.reason, quantity: o.filledQuantity, price: o.fillPrice });
    out.logs.push({ level: "INFO", message: `Exit ${action} ${o.filledQuantity}/${qty} @ ${o.fillPrice ?? "-"} (${ex.reason})`, context: { marketId: p.marketId } });
  }

  const pfView = () => {
    const snap = portfolio.snapshot(state.books, ts);
    return {
      equity: snap.equity,
      cash: portfolio.cash,
      grossExposure: portfolio.grossExposure(),
      drawdown: snap.drawdown,
      marketExposure: (id: string) => portfolio.marketExposure(id),
      raceExposure: (id: string) => portfolio.raceExposure(id),
    };
  };

  let newTrades = 0;
  const execute = (o: Opportunity, scenario: string, fairSd: number) => {
    if (newTrades >= cfg.maxNewTradesPerTick && !o.closesPosition) return;
    const strategy = args.sizingMode === "auto" ? selectStrategy(scenario, args.rules) : args.sizingMode;
    const view = pfView();
    let notional = rawNotional(strategy, o, view.equity, fairSd, cfg.risk);
    if (o.opportunityType === "headline") notional *= cfg.risk.headlineMultiplier;
    const size = constrainSize(o, notional, view, cfg.risk);
    const d: Decision = {
      ...o,
      quantity: size.quantity,
      estimatedCost: round(size.notional, 2),
      sizingStrategy: strategy,
      scenario,
      portfolioExposureAfter: view.equity ? round((view.grossExposure + size.notional) / view.equity, 4) : 0,
      timestamp: ts,
      rejected: size.quantity <= 0 ? `risk:${size.limitedBy}` : undefined,
    };
    out.decisions.push(d);
    args.onDecision?.(d);
    if (size.quantity <= 0) {
      out.logs.push({ level: "WARNING", message: `Rejected ${o.action} ${o.marketId}: ${size.limitedBy}`, context: { marketId: o.marketId } });
      return;
    }
    const contractFair = o.fairValue;
    const order = exec.submitOrder({
      marketId: o.marketId,
      action: o.action,
      quantity: size.quantity,
      orderType: "market",
      tag: `${o.opportunityType}:${scenario}:${strategy}`,
      meta: {
        fair: contractFair,
        tradeType: o.opportunityType,
        // Exit price available right after entry, for the contract actually held after the fill
        // (an unbacked SELL_YES leaves us holding NO).
        liquidationValue: liquidationAfterEntry(exec.book(o.marketId), heldContract(o)),
      },
    });
    if (order.filledQuantity > 0) newTrades++;
    out.logs.push({
      level: order.filledQuantity > 0 ? "INFO" : "WARNING",
      message: `${o.opportunityType.toUpperCase()} ${o.action} ${order.filledQuantity}/${size.quantity} @ ${order.fillPrice ?? "-"} edge ${(o.netEdge * 100).toFixed(2)}pp [${strategy}]`,
      context: { marketId: o.marketId, orderId: order.orderId, reason: o.reason },
    });
  };

  // 2. Arbitrage: allocate capital across ALL simultaneous sets by expected return on capital.
  if (signals.arbitrage.length) {
    const view = pfView();
    const arbExposure = portfolio.positions().filter((p) => p.tradeType === "arbitrage").reduce((s, p) => s + p.lots.reduce((a, l) => a + l.quantity * l.price, 0), 0);
    const raceArb = (race: string) =>
      portfolio
        .positions()
        .filter((p) => p.tradeType === "arbitrage" && portfolio.raceOf(p.marketId) === race)
        .reduce((s, p) => s + p.lots.reduce((a, l) => a + l.quantity * l.price, 0), 0);
    const settleDays = (a: ArbitrageOpportunity) => {
      const d = a.legs.map((l) => titles.get(l.marketId)).filter(Boolean).map((m) => daysTo(m!.settlementDate, state.now));
      return d.length ? Math.max(1, Math.max(...d)) : 30;
    };
    const cands: ArbCandidate[] = [];
    for (const a of signals.arbitrage) {
      let convergence = 1;
      if (a.conditional) {
        if (!cfg.risk.allowConditionalArb) continue;
        // P(one of the listed parties wins) from our own fair values.
        convergence = Math.min(1, a.legs.reduce((s, l) => s + (signals.fair.get(l.marketId)?.fairProbability ?? 0), 0));
        if (convergence < cfg.risk.minConvergence) continue;
      }
      cands.push({ arb: a, convergence, daysToSettlement: settleDays(a) });
    }
    const budget = Math.min(
      view.cash - view.equity * cfg.risk.cashReservePct,
      view.equity * cfg.risk.maxArbitragePct - arbExposure,
    );
    const allocations = allocateArbitrage(cands, {
      budget,
      raceCap: (race) => {
        const legRace = signals.arbitrage.find((x) => x.raceId === race)?.legs[0]?.marketId;
        return view.equity * cfg.risk.maxArbRacePct - (legRace ? raceArb(portfolio.raceOf(legRace)) : 0);
      },
      minQuantity: cfg.risk.minQuantity,
      minReturn: cfg.risk.minArbReturn,
    });
    for (const al of allocations) {
      const a = al.arb;
      // Re-size against the books as they are now (earlier fills this tick may have consumed depth).
      const live = sizeSet(
        a.legs.map((l) => ({ marketId: l.marketId, action: l.action, book: exec.book(l.marketId)! })).filter((x) => x.book),
        a.guaranteedPayoutPerSet,
        al.quantity,
      );
      if (!live || live.legs.length !== a.legs.length || live.q < cfg.risk.minQuantity) {
        out.logs.push({ level: "WARNING", message: `ARB ${a.raceId} skipped: depth gone before execution`, context: { raceId: a.raceId } });
        continue;
      }
      const q = live.q;
      const cps = live.cost / q;
      for (const leg of live.legs) {
        const d: Decision = {
          marketId: leg.marketId,
          title: titles.get(leg.marketId)?.title ?? leg.marketId,
          action: leg.action,
          contract: leg.action.endsWith("YES") ? "YES" : "NO",
          opportunityType: "arbitrage",
          executablePrice: leg.price,
          vwap: leg.price,
          bestPrice: leg.price,
          fairValue: round(leg.price + (a.guaranteedPayoutPerSet * al.convergence - cps) / live.legs.length, 4),
          grossEdge: round((a.guaranteedPayoutPerSet - cps) / live.legs.length, 4),
          spreadCost: 0,
          slippage: 0,
          transactionCosts: 0,
          netEdge: round((a.guaranteedPayoutPerSet * al.convergence - cps) / live.legs.length, 4),
          expectedReturn: al.expectedReturn,
          confidence: al.convergence,
          availableQuantity: a.quantity,
          evaluatedQuantity: q,
          maxLossPerShare: a.conditional ? leg.price : 0,
          riskAdjustedScore: round(100 * al.annualizedReturn, 3),
          equivalentTo: [],
          closesPosition: false,
          reason:
            `${a.note} Race ${a.raceId}: ${q} sets at ${cps.toFixed(4)} each, payout ${a.guaranteedPayoutPerSet}` +
            `${a.conditional ? ` x P(listed wins) ${al.convergence.toFixed(3)}` : ""}; expected profit ${al.expectedProfit.toFixed(2)} ` +
            `(${(al.expectedReturn * 100).toFixed(2)}% on ${al.cost.toFixed(0)} locked, ${(al.annualizedReturn * 100).toFixed(1)}% annualised); size limited by ${al.limitedBy}.`,
          quantity: q,
          estimatedCost: round(q * leg.price, 2),
          sizingStrategy: "fixed_fractional",
          scenario: "arbitrage",
          portfolioExposureAfter: view.equity ? round((view.grossExposure + live.cost) / view.equity, 4) : 0,
          timestamp: ts,
        };
        out.decisions.push(d);
        args.onDecision?.(d);
        const o = exec.submitOrder({ marketId: leg.marketId, action: leg.action, quantity: q, orderType: "market", tag: `arbitrage:arbitrage:${a.kind}`, meta: { tradeType: "arbitrage" } });
        if (o.filledQuantity < q) out.logs.push({ level: "WARNING", message: `ARB leg ${leg.action} #${leg.marketId} filled ${o.filledQuantity}/${q}`, context: { raceId: a.raceId } });
        out.logs.push({ level: "INFO", message: `ARB ${a.kind} ${leg.action} ${o.filledQuantity}@${o.fillPrice}`, context: { marketId: leg.marketId, raceId: a.raceId } });
      }
    }
  }

  // 3. Headline trades (time sensitive).
  for (const h of signals.headlines) {
    const key = `${h.marketId}:${h.headline.id}`;
    if (args.tradedHeadlines.has(key)) continue;
    const base = signals.fair.get(h.marketId);
    const book = exec.book(h.marketId);
    const m = titles.get(h.marketId);
    if (!base || !book || !m) continue;
    const shifted: FairValueEstimate = {
      ...base,
      fairProbability: Math.min(0.995, Math.max(0.005, base.fairProbability + h.shift)),
      confidence: Math.min(base.confidence, Math.max(0.3, h.confidence)),
      reasoning: `${base.reasoning}; headline "${h.headline.title}" (${h.headline.source}) shift ${(h.shift * 100).toFixed(1)}pp`,
    };
    const opps = evaluateMarket({ marketId: m.id, title: m.title, book, fair: shifted, holdings: portfolio.holdings(m.id), params: cfg.eval, type: "headline" })
      .map((o) => ({ ...o, headline: { id: h.headline.id, title: h.headline.title, source: h.headline.source, shift: h.shift } }));
    out.evaluated += opps.length;
    const best = rankOpportunities(opps, cfg.minNetEdge, 0.25).filter((o) => !o.closesPosition)[0];
    args.tradedHeadlines.add(key);
    if (best) execute(best, "headline", (shifted.upperBound - shifted.lowerBound) / 3.92);
  }

  // 4. Regular opportunities across the whole universe.
  const all: Opportunity[] = [];
  for (const m of state.markets) {
    const f = signals.fair.get(m.id);
    const book = exec.book(m.id);
    if (!f || !book) continue;
    const opps = evaluateMarket({ marketId: m.id, title: m.title, book, fair: f, holdings: portfolio.holdings(m.id), params: cfg.eval });
    out.evaluated += opps.length;
    all.push(...opps);
  }
  for (const o of rankOpportunities(all, cfg.minNetEdge, cfg.minConfidence)) {
    if (o.closesPosition) continue; // closes are handled by exit logic
    const m = titles.get(o.marketId)!;
    const f = signals.fair.get(o.marketId)!;
    execute(o, scenarioOf(o, daysTo(m.settlementDate, state.now)), (f.upperBound - f.lowerBound) / 3.92);
  }
  return out;
}

function heldContract(o: Opportunity): "YES" | "NO" {
  if (o.action.startsWith("BUY") || o.closesPosition) return o.contract;
  return o.contract === "YES" ? "NO" : "YES";
}

function liquidationAfterEntry(book: YesBook | undefined, contract: "YES" | "NO"): number | undefined {
  if (!book) return undefined;
  const s = bookStats(book);
  if (contract === "YES") return s.bestBid ?? undefined;
  return s.bestAsk !== null ? round(1 - s.bestAsk, 4) : undefined;
}
