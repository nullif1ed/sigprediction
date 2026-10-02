import type { Action, Contract, Fill, OpportunityType, Position, YesBook } from "./types";
import { bookStats, contractOf, round } from "./orderbook";

export interface PortfolioSnapshot {
  timestamp: string;
  cash: number;
  equity: number; // cash + positions at mid
  liquidationEquity: number; // cash + positions at executable exit prices
  realizedPnl: number;
  unrealizedPnl: number;
  grossExposure: number; // cost basis
  netExposure: number; // YES-equivalent delta notional
  peakEquity: number;
  drawdown: number;
  maxDrawdown: number;
  positions: number;
}

const other = (c: Contract): Contract => (c === "YES" ? "NO" : "YES");

/**
 * Paper portfolio that follows SIG settlement rules:
 *  - a YES share and a NO share in the same market net to 1 SUSQie (opposite buys net FIFO),
 *  - a sale larger than holdings is canonicalised into the complement buy.
 */
export class Portfolio {
  cash: number;
  readonly initialCapital: number;
  realizedPnl = 0;
  peakEquity: number;
  maxDrawdown = 0;
  private pos = new Map<string, Position>(); // key marketId:contract
  raceOf: (marketId: string) => string = (m) => m;
  /**
   * Shares locked in arbitrage sets, per marketId:contract, with their cost. Regular exits never
   * sell these, and regular trades never net against them; they leave only by a full-set unwind.
   */
  arb = new Map<string, { quantity: number; cost: number }>();
  /** raceId -> marketIds of every leg of the arbitrage set held in that race */
  arbSets = new Map<string, string[]>();
  /** cash committed elsewhere (resting swing bids): not available to arbitrage entries */
  reservedCash = 0;
  /** marketId -> epoch ms until which new regular entries are blocked (after a stop loss) */
  cooldownUntil = new Map<string, number>();

  constructor(initialCapital: number) {
    this.cash = initialCapital;
    this.initialCapital = initialCapital;
    this.peakEquity = initialCapital;
  }

  private key(m: string, c: Contract) {
    return `${m}:${c}`;
  }

  get(marketId: string, contract: Contract): Position | undefined {
    return this.pos.get(this.key(marketId, contract));
  }

  holdings(marketId: string) {
    return { YES: this.get(marketId, "YES")?.quantity ?? 0, NO: this.get(marketId, "NO")?.quantity ?? 0 };
  }

  /** Holdings available to regular trading (arbitrage-locked shares excluded). */
  freeHoldings(marketId: string) {
    const h = this.holdings(marketId);
    return { YES: Math.max(0, h.YES - this.arbQty(marketId, "YES")), NO: Math.max(0, h.NO - this.arbQty(marketId, "NO")) };
  }

  arbQty(marketId: string, contract: Contract): number {
    return Math.min(this.arb.get(this.key(marketId, contract))?.quantity ?? 0, this.get(marketId, contract)?.quantity ?? 0);
  }

  arbCost(marketId: string, contract: Contract): number {
    return this.arb.get(this.key(marketId, contract))?.cost ?? 0;
  }

  /** Record shares bought (q > 0) or unwound (q < 0) as part of an arbitrage set. */
  markArb(marketId: string, contract: Contract, q: number, cost: number) {
    const k = this.key(marketId, contract);
    const cur = this.arb.get(k) ?? { quantity: 0, cost: 0 };
    if (q < 0 && cur.quantity > 0) cost = (cur.cost / cur.quantity) * q; // release average cost
    const next = { quantity: cur.quantity + q, cost: cur.cost + cost };
    if (next.quantity <= 0) this.arb.delete(k);
    else this.arb.set(k, next);
  }

  /**
   * Replace positions and cash with the exchange's authoritative state (live trading). Local
   * metadata (trade type, entry fair, exit state) is kept for positions that still exist, and
   * arbitrage locks are clipped to what is really held.
   */
  syncFromExchange(rows: { marketId: string; contract: Contract; quantity: number; avgEntry: number; lots: { quantity: number; price: number }[] }[], cash: number, ts: string) {
    const next = new Map<string, Position>();
    for (const r of rows) {
      if (r.quantity <= 0) continue;
      const k = this.key(r.marketId, r.contract);
      const prev = this.pos.get(k);
      const lots = r.lots.length ? r.lots.map((l) => ({ ...l })) : [{ quantity: r.quantity, price: r.avgEntry }];
      const sameQty = prev && Math.abs(prev.quantity - r.quantity) < 1e-9;
      next.set(k, {
        marketId: r.marketId,
        contract: r.contract,
        quantity: r.quantity,
        avgEntry: r.avgEntry,
        lots,
        openedAt: prev?.openedAt ?? ts,
        entryFair: prev?.entryFair ?? null,
        entryLiquidationValue: prev?.entryLiquidationValue ?? null,
        tradeType: prev?.tradeType ?? (this.arb.has(k) ? "arbitrage" : "regular"),
        realizedPnl: prev?.realizedPnl ?? 0,
        ...(sameQty ? { peakProfitPp: (prev as Position & { peakProfitPp?: number }).peakProfitPp, stopStrikes: (prev as Position & { stopStrikes?: number }).stopStrikes } : {}),
      } as Position);
    }
    this.pos = next;
    this.cash = cash;
    for (const [k, v] of [...this.arb]) {
      const held = this.pos.get(k)?.quantity ?? 0;
      if (held <= 0) this.arb.delete(k);
      else if (held < v.quantity) this.arb.set(k, { quantity: held, cost: (v.cost / v.quantity) * held });
    }
    for (const [race, ids] of [...this.arbSets]) if (!ids.some((id) => this.arb.has(`${id}:NO`) || this.arb.has(`${id}:YES`))) this.arbSets.delete(race);
  }

  arbExposure(): number {
    let s = 0;
    for (const v of this.arb.values()) s += v.cost;
    return s;
  }

  raceArbExposure(marketId: string): number {
    const race = this.raceOf(marketId);
    let s = 0;
    for (const [k, v] of this.arb) if (this.raceOf(k.split(":")[0]) === race) s += v.cost;
    return s;
  }

  positions(): Position[] {
    return [...this.pos.values()].filter((p) => p.quantity > 0);
  }

  marketExposure(marketId: string): number {
    return (["YES", "NO"] as Contract[]).reduce((s, c) => s + costBasis(this.get(marketId, c)), 0);
  }

  raceExposure(marketId: string): number {
    const race = this.raceOf(marketId);
    return this.positions()
      .filter((p) => this.raceOf(p.marketId) === race)
      .reduce((s, p) => s + costBasis(p), 0);
  }

  grossExposure(): number {
    return this.positions().reduce((s, p) => s + costBasis(p), 0);
  }

  /** FIFO reduce; returns realized pnl given a per-share exit value. */
  private reduce(p: Position, qty: number, exitValue: number): number {
    let remaining = qty;
    let pnl = 0;
    while (remaining > 0 && p.lots.length) {
      const lot = p.lots[0];
      const take = Math.min(remaining, lot.quantity);
      pnl += take * (exitValue - lot.price);
      lot.quantity -= take;
      remaining -= take;
      if (lot.quantity <= 0) p.lots.shift();
    }
    p.quantity -= qty - remaining;
    p.avgEntry = p.quantity > 0 ? p.lots.reduce((s, l) => s + l.quantity * l.price, 0) / p.quantity : 0;
    p.realizedPnl += pnl;
    if (p.quantity <= 0) this.pos.delete(this.key(p.marketId, p.contract));
    return pnl;
  }

  private open(marketId: string, contract: Contract, qty: number, price: number, ts: string, meta: OpenMeta) {
    const k = this.key(marketId, contract);
    const p: Position = this.pos.get(k) ?? {
      marketId,
      contract,
      quantity: 0,
      avgEntry: 0,
      lots: [],
      openedAt: ts,
      entryFair: meta.fair ?? null,
      entryLiquidationValue: meta.liquidationValue ?? null,
      tradeType: meta.tradeType ?? "regular",
      realizedPnl: 0,
    };
    p.lots.push({ quantity: qty, price });
    p.quantity += qty;
    // Adding shares changes the entry price: restart the exit state machine for this position.
    delete (p as Position & { peakProfitPp?: number }).peakProfitPp;
    delete (p as Position & { stopStrikes?: number }).stopStrikes;
    p.avgEntry = p.lots.reduce((s, l) => s + l.quantity * l.price, 0) / p.quantity;
    if (meta.fair !== undefined) p.entryFair = meta.fair;
    this.pos.set(k, p);
  }

  /**
   * Apply an execution. `price` is in the action's contract terms.
   * Returns the realized P&L produced by the fill.
   */
  applyFill(marketId: string, action: Action, qty: number, price: number, ts: string, meta: OpenMeta = {}): number {
    if (qty <= 0) return 0;
    const c = contractOf(action);
    let realized = 0;
    if (action.startsWith("BUY")) {
      // A buy of X first nets against held opposite shares (pair redeems for 1).
      const opp = this.get(marketId, other(c));
      const net = Math.min(qty, opp?.quantity ?? 0);
      if (net > 0 && opp) {
        realized += this.reduce(opp, net, 1 - price);
        this.cash += net * (1 - price);
      }
      const rest = qty - net;
      if (rest > 0) {
        this.cash -= rest * price;
        this.open(marketId, c, rest, price, ts, meta);
      }
    } else {
      const held = this.get(marketId, c);
      const backed = Math.min(qty, held?.quantity ?? 0);
      if (backed > 0 && held) {
        realized += this.reduce(held, backed, price);
        this.cash += backed * price;
      }
      const unbacked = qty - backed;
      if (unbacked > 0) {
        // sell X q@p == buy (not X) q@(1-p)
        const comp: Action = c === "YES" ? "BUY_NO" : "BUY_YES";
        realized += this.applyFill(marketId, comp, unbacked, round(1 - price), ts, meta);
      }
    }
    this.realizedPnl += realized;
    return realized;
  }

  /** Settle a market: YES pays `yesValue` (1 or 0; 0.5-style refunds supported). */
  settle(marketId: string, yesValue: number): number {
    let pnl = 0;
    for (const c of ["YES", "NO"] as Contract[]) {
      const p = this.get(marketId, c);
      if (!p) continue;
      const v = c === "YES" ? yesValue : 1 - yesValue;
      const q = p.quantity;
      pnl += this.reduce(p, q, v);
      this.cash += q * v;
    }
    this.realizedPnl += pnl;
    return pnl;
  }

  snapshot(books: Map<string, YesBook>, ts: string): PortfolioSnapshot {
    let mtm = 0;
    let liq = 0;
    let cost = 0;
    let net = 0;
    for (const p of this.positions()) {
      const b = books.get(p.marketId);
      const v = valuePosition(p, b);
      mtm += v.mid;
      liq += v.liquidation;
      cost += costBasis(p);
      net += (p.contract === "YES" ? 1 : -1) * v.mid;
    }
    const equity = this.cash + mtm;
    this.peakEquity = Math.max(this.peakEquity, equity);
    const dd = this.peakEquity > 0 ? (this.peakEquity - equity) / this.peakEquity : 0;
    this.maxDrawdown = Math.max(this.maxDrawdown, dd);
    return {
      timestamp: ts,
      cash: round(this.cash, 2),
      equity: round(equity, 2),
      liquidationEquity: round(this.cash + liq, 2),
      realizedPnl: round(this.realizedPnl, 2),
      unrealizedPnl: round(mtm - cost, 2),
      grossExposure: round(cost, 2),
      netExposure: round(net, 2),
      peakEquity: round(this.peakEquity, 2),
      drawdown: round(dd, 5),
      maxDrawdown: round(this.maxDrawdown, 5),
      positions: this.positions().length,
    };
  }

  toJSON() {
    return {
      cash: this.cash,
      initialCapital: this.initialCapital,
      realizedPnl: this.realizedPnl,
      peakEquity: this.peakEquity,
      maxDrawdown: this.maxDrawdown,
      positions: this.positions(),
      arb: [...this.arb.entries()],
      arbSets: [...this.arbSets.entries()],
      cooldownUntil: [...this.cooldownUntil.entries()],
    };
  }

  static fromJSON(j: Omit<ReturnType<Portfolio["toJSON"]>, "arb" | "cooldownUntil" | "arbSets"> & Partial<Pick<ReturnType<Portfolio["toJSON"]>, "arb" | "cooldownUntil" | "arbSets">>): Portfolio {
    const p = new Portfolio(j.initialCapital);
    p.cash = j.cash;
    p.realizedPnl = j.realizedPnl;
    p.peakEquity = j.peakEquity;
    p.maxDrawdown = j.maxDrawdown;
    for (const x of j.positions) p.pos.set(`${x.marketId}:${x.contract}`, { ...x, lots: x.lots.map((l) => ({ ...l })) });
    if (j.arb) p.arb = new Map(j.arb);
    else
      // Portfolios saved before arbitrage tracking: positions opened as arbitrage are fully locked.
      for (const x of j.positions) if (x.tradeType === "arbitrage") p.arb.set(`${x.marketId}:${x.contract}`, { quantity: x.quantity, cost: costBasis(x) });
    if (j.cooldownUntil) p.cooldownUntil = new Map(j.cooldownUntil);
    if (j.arbSets) p.arbSets = new Map(j.arbSets);
    return p;
  }
}

export interface OpenMeta {
  fair?: number;
  liquidationValue?: number;
  tradeType?: OpportunityType;
}

export function costBasis(p?: Position): number {
  return p ? p.lots.reduce((s, l) => s + l.quantity * l.price, 0) : 0;
}

/** Value a position at the YES mid and at the executable exit (bid side of the held contract). */
export function valuePosition(p: Position, book?: YesBook) {
  const cb = costBasis(p);
  if (!book) return { mid: cb, liquidation: cb, markPrice: p.avgEntry, exitPrice: null as number | null };
  const s = bookStats(book);
  const yesMid = s.mid ?? s.bestBid ?? s.bestAsk;
  // No price at all: hold at cost (avgEntry is already in the held contract's terms).
  const markPrice = yesMid === null ? p.avgEntry : p.contract === "YES" ? yesMid : 1 - yesMid;
  // Exit: YES holder hits YES bid; NO holder sells NO = lifts YES ask -> receives 1 - ask.
  const exitPrice = p.contract === "YES" ? s.bestBid : s.bestAsk !== null ? 1 - s.bestAsk : null;
  return {
    mid: p.quantity * markPrice,
    liquidation: p.quantity * (exitPrice ?? 0),
    markPrice: round(markPrice, 4),
    exitPrice: exitPrice === null ? null : round(exitPrice, 4),
  };
}

export function fillRecord(f: Omit<Fill, "yesPrice">): Fill {
  const yes = f.action === "BUY_YES" || f.action === "SELL_YES" ? f.price : 1 - f.price;
  return { ...f, yesPrice: round(yes, 4) };
}
