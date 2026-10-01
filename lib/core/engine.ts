import type {
  Action,
  Decision,
  ExternalQuote,
  FairValueEstimate,
  NewsHeadline,
  Opportunity,
  SigMarket,
  SizingStrategyName,
  YesBook,
} from "./types";
import { bookStats, contractLevels, contractMid, round } from "./orderbook";
import { DEFAULT_FAIR_VALUE, estimateFairValue, type FairValueParams } from "./fairValue";
import { DEFAULT_IMPACT, headlineImpact, type ImpactParams } from "./news";
import { DEFAULT_EVAL, evaluateMarket, rankOpportunities, type EvalParams } from "./opportunity";
import { detectArbitrage, sizeSet, type ArbitrageOpportunity } from "./arbitrage";
import { allocateArbitrage, type ArbCandidate } from "./arbAllocation";
import { constrainSize, DEFAULT_RISK, rawNotional, scenarioOf, selectStrategy, type RiskConfig, type ScenarioRules } from "./sizing";
import { DEFAULT_EXITS, shouldExit, sizeUnwind, type ExitConfig } from "./exits";
import { valuePosition, type Portfolio } from "./portfolio";
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
  /** regular entries need net edge >= this multiple of the current spread (round-trip cost) */
  minEdgeToSpread: number;
  /** minutes a market is blocked for new regular entries after a stop-loss exit */
  reentryCooldownMinutes: number;
  /** never add to a regular position that is currently below entry at the executable exit */
  addOnlyWhenProfitable: boolean;
  /** "auto" picks a sizing strategy per scenario using backtest-learned rules */
  sizing: SizingStrategyName | "auto";
  basedOn?: string | null;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  name: "baseline",
  description: "Day-1 tuned: 1pp take-profit on executable VWAP, confirmed 4pp stop with dislocation guard, locked + unwindable arbitrage.",
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
  minEdgeToSpread: 0,
  reentryCooldownMinutes: 30,
  addOnlyWhenProfitable: true,
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

  // 1. Re-evaluate and exit existing positions (arbitrage-locked shares are managed separately).
  for (const p of portfolio.positions()) {
    const free = p.quantity - portfolio.arbQty(p.marketId, p.contract);
    if (free <= 0) continue;
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
      qty: free,
    });
    if (!ex.exit) continue;
    const action = p.contract === "YES" ? "SELL_YES" : "SELL_NO";
    const qty = Math.min(free, ex.quantity ?? free);
    const o = exec.submitOrder({ marketId: p.marketId, action, quantity: qty, orderType: "market", limitPrice: ex.limitPrice ?? null, tag: `exit:${ex.reason}` });
    if (ex.reason === "stop_loss" || ex.reason === "breakeven_stop")
      portfolio.cooldownUntil.set(p.marketId, state.now.getTime() + cfg.reentryCooldownMinutes * 60_000);
    out.exits.push({ marketId: p.marketId, contract: p.contract, reason: ex.reason, quantity: o.filledQuantity, price: o.fillPrice });
    out.logs.push({
      level: "INFO",
      message: `Exit ${action} ${o.filledQuantity}/${qty} of ${free} @ ${o.fillPrice ?? "-"} (${ex.reason}, limit ${ex.limitPrice ?? "-"})`,
      context: { marketId: p.marketId },
    });
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

  /** Why a new regular/headline entry is not allowed right now (null when allowed). */
  const entryBlock = (o: Opportunity): string | null => {
    if (o.closesPosition) return null;
    const id = o.marketId;
    // Shares in an arbitrage set must not be netted or mixed with directional trades.
    if (portfolio.arbQty(id, "YES") + portfolio.arbQty(id, "NO") > 0) return "arb_locked";
    if ((portfolio.cooldownUntil.get(id) ?? 0) > state.now.getTime()) return "cooldown";
    const book = exec.book(id);
    if (!book) return "no_book";
    const pos = portfolio.get(id, heldContract(o));
    if (cfg.addOnlyWhenProfitable && pos && pos.quantity > 0) {
      const v = valuePosition(pos, book);
      if (v.exitPrice === null || v.exitPrice < pos.avgEntry) return "underwater_add";
    }
    if (cfg.minEdgeToSpread > 0) {
      const st = bookStats(book);
      if (st.spread !== null && o.netEdge < cfg.minEdgeToSpread * st.spread) return "edge_below_spread";
    }
    return null;
  };

  let newTrades = 0;
  const execute = (o: Opportunity, scenario: string, fairSd: number) => {
    if (newTrades >= cfg.maxNewTradesPerTick && !o.closesPosition) return;
    if (entryBlock(o)) return;
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

  // 2a. Arbitrage unwind: a held set can often be sold back for most of its locked profit long
  // before settlement. Realising it frees the capital for the next set (other bots keep re-opening
  // the same spreads), and protects the gain if the set is still open at the tournament end.
  if (cfg.risk.arbUnwind) {
    const byRace = new Map<string, { marketId: string; contract: "YES" | "NO" }[]>();
    for (const k of portfolio.arb.keys()) {
      const [marketId, contract] = k.split(":") as [string, "YES" | "NO"];
      if (portfolio.arbQty(marketId, contract) <= 0) continue;
      const mk = titles.get(marketId);
      const r = mk?.race ? raceId(mk.race) : portfolio.raceOf(marketId);
      byRace.set(r, [...(byRace.get(r) ?? []), { marketId, contract }]);
    }
    for (const [race, held] of byRace) {
      if (held.length < 2 || held.some((h) => h.contract !== held[0].contract)) continue;
      const legs = held.map((h) => ({
        marketId: h.marketId,
        action: (h.contract === "YES" ? "SELL_YES" : "SELL_NO") as Action,
        book: exec.book(h.marketId)!,
        held: portfolio.arbQty(h.marketId, h.contract),
      }));
      if (legs.some((l) => !l.book)) continue;
      const costPerSet = held.reduce((sum, h) => sum + portfolio.arbCost(h.marketId, h.contract) / Math.max(1, portfolio.arb.get(`${h.marketId}:${h.contract}`)?.quantity ?? 1), 0);
      const payout = held[0].contract === "NO" ? held.length - 1 : 1;
      const locked = payout - costPerSet;
      const need = costPerSet + Math.max(cfg.risk.arbUnwindMinPp, cfg.risk.arbUnwindCapture * locked);
      const u = sizeUnwind(legs, need);
      if (!u || u.q < cfg.risk.minQuantity) continue;
      for (const leg of u.legs) {
        const contract = leg.action.endsWith("YES") ? "YES" : "NO";
        const o = exec.submitOrder({ marketId: leg.marketId, action: leg.action, quantity: u.q, orderType: "market", limitPrice: leg.limit, tag: "arbexit:unwind" });
        portfolio.markArb(leg.marketId, contract, -o.filledQuantity, 0);
        out.exits.push({ marketId: leg.marketId, contract, reason: "arb_unwind", quantity: o.filledQuantity, price: o.fillPrice });
      }
      out.logs.push({
        level: "INFO",
        message: `ARB unwind ${race}: sold ${u.q} sets at ${(u.proceeds / u.q).toFixed(4)} (cost ${costPerSet.toFixed(4)}, payout ${payout})`,
        context: { raceId: race, profit: round((u.proceeds / u.q - costPerSet) * u.q, 2) },
      });
    }
  }

  // 2b. Arbitrage entry: allocate capital across ALL simultaneous sets by return on capital
  // (widest spread first), sized on the books net of our own earlier fills.
  const liveArbs = cfg.arbitrage
    ? detectArbitrage(
        state.markets
          .filter((m) => m.race && exec.book(m.id))
          .map((m) => ({ marketId: m.id, race: m.race!, book: exec.book(m.id)! })),
      )
    : [];
  if (liveArbs.length) {
    const view = pfView();
    const settleDays = (a: ArbitrageOpportunity) => {
      const d = a.legs.map((l) => titles.get(l.marketId)).filter(Boolean).map((m) => daysTo(m!.settlementDate, state.now));
      return d.length ? Math.max(1, Math.max(...d)) : 30;
    };
    const cands: ArbCandidate[] = [];
    for (const a of liveArbs) {
      // Buying a leg's contract while holding the opposite (regular) side would net the two
      // positions instead of opening the set; skip those races.
      const conflict = a.legs.some((l) => {
        const c = l.action.endsWith("YES") ? "NO" : "YES";
        return portfolio.freeHoldings(l.marketId)[c] > 0;
      });
      if (conflict) continue;
      let convergence = 1;
      if (a.conditional) {
        if (!cfg.risk.allowConditionalArb) continue;
        convergence = Math.min(1, a.legs.reduce((sum, l) => sum + (signals.fair.get(l.marketId)?.fairProbability ?? 0), 0));
        if (convergence < cfg.risk.minConvergence) continue;
      }
      cands.push({ arb: a, convergence, daysToSettlement: settleDays(a) });
    }
    const budget = Math.min(view.cash - view.equity * cfg.risk.cashReservePct, view.equity * cfg.risk.maxArbitragePct - portfolio.arbExposure());
    const allocations = allocateArbitrage(cands, {
      budget,
      raceCap: (race) => {
        const leg = liveArbs.find((x) => x.raceId === race)?.legs[0]?.marketId;
        return view.equity * cfg.risk.maxArbRacePct - (leg ? portfolio.raceArbExposure(leg) : 0);
      },
      minQuantity: cfg.risk.minQuantity,
      minReturn: cfg.risk.minArbReturn,
    });
    for (const al of allocations) {
      const a = al.arb;
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
      // Every leg gets a limit at its worst planned level, so a leg can never fill worse than planned.
      const worst = new Map(a.legs.map((l) => [l.marketId, l.price]));
      for (const leg of live.legs) {
        const ladder = contractLevels(exec.book(leg.marketId)!, leg.action);
        let left = q;
        for (const lv of ladder) {
          worst.set(leg.marketId, lv.price);
          left -= lv.quantity;
          if (left <= 0) break;
        }
      }
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
        const o = exec.submitOrder({
          marketId: leg.marketId,
          action: leg.action,
          quantity: q,
          orderType: "market",
          limitPrice: worst.get(leg.marketId) ?? null,
          tag: `arbitrage:arbitrage:${a.kind}`,
          meta: { tradeType: "arbitrage" },
        });
        portfolio.markArb(leg.marketId, d.contract, o.filledQuantity, o.filledQuantity * (o.fillPrice ?? 0));
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
    const opps = evaluateMarket({ marketId: m.id, title: m.title, book, fair: shifted, holdings: portfolio.freeHoldings(m.id), params: cfg.eval, type: "headline" })
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
    const opps = evaluateMarket({ marketId: m.id, title: m.title, book, fair: f, holdings: portfolio.freeHoldings(m.id), params: cfg.eval });
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
