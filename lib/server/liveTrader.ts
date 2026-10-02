import { randomUUID } from "node:crypto";
import { config } from "./config";
import { log } from "./log";
import { SigApiError, type OrderInput, type OrderResult, type SigClient } from "./sigClient";
import type { Contract, PaperOrder, SigMarket, YesBook } from "../core/types";
import type { Portfolio } from "../core/portfolio";
import { availableQuantity, contractLevels, round } from "../core/orderbook";
import { raceId } from "../core/races";
import { sizeSet } from "../core/arbitrage";

// LIVE execution on SIG.
//
// The strategy engine decides on its (paper) execution client exactly as in paper trading: that
// simulates the fill against the current order book and books the position. Every order it fills
// is then mirrored to SIG as a LIMIT order at the worst price the simulation walked (so a live
// fill is never worse than the decision assumed), arbitrage sets/unwinds as one atomic
// multi-leg request. Any unfilled remainder is cancelled straight away. After each batch, and
// every LIVE_RECONCILE_SEC, positions and cash are replaced by SIG's authoritative portfolio, so
// the engine always works from what was really filled.
//
// Safety:
//  - only when LIVE_TRADING=1;
//  - sells are clipped to shares really held (an unbacked SELL would be turned into a BUY by SIG);
//  - one leg never exceeds LIVE_MAX_ORDER_NOTIONAL;
//  - stale entries are dropped; exits are never dropped;
//  - new entries stop when account value falls LIVE_MAX_DRAWDOWN below its start (exits continue).

export interface LiveStats {
  enabled: boolean;
  halted: string | null;
  startValue: number | null;
  accountValue: number | null;
  /** cash + guaranteed payout of complete arbitrage sets + market value of other holdings */
  securedValue: number | null;
  cash: number | null;
  ordersSent: number;
  ordersFilled: number;
  sharesFilled: number;
  dropped: number;
  errors: number;
  lastError: string | null;
  lastReconcileAt: string | null;
  writesLastMinute: number;
  queue: number;
}

interface Pending {
  o: PaperOrder;
  queuedAt: number;
}

const TICK = 0.005;
const onTick = (p: number, dir: "up" | "down") => {
  const k = dir === "up" ? Math.ceil(p / TICK - 1e-9) : Math.floor(p / TICK + 1e-9);
  return round(Math.min(0.995, Math.max(0.005, k * TICK)), 3);
};
// Exits, unwinds and leg repairs reduce risk: they are sent first and never dropped.
const isExit = (o: PaperOrder) => /^(exit|arbexit)|:repair/.test(o.tag ?? "");

export class LiveTrader {
  /** YOLO: the first leg may pay up to break-even (market-like), not just half the planned profit */
  aggressive = false;
  private queue: Pending[] = [];
  private busy = false;
  private lastReconcile = 0;
  /** shares really held per marketId:contract (from the last reconcile plus confirmed fills since) */
  private real = new Map<string, number>();
  stats: LiveStats = {
    enabled: true,
    halted: null,
    startValue: null,
    accountValue: null,
    securedValue: null,
    cash: null,
    ordersSent: 0,
    ordersFilled: 0,
    sharesFilled: 0,
    dropped: 0,
    errors: 0,
    lastError: null,
    lastReconcileAt: null,
    writesLastMinute: 0,
    queue: 0,
  };

  constructor(
    private client: SigClient,
    private tournamentId: string,
    private markets: () => SigMarket[],
    private portfolio: () => Portfolio | null,
    /** called after each reconcile */
    private onReconciled: () => void = () => {},
    /**
     * When directional trading is off, every position on a race is (part of) an arbitrage set,
     * including a lone leg whose partner never filled: adopt it so leg repair balances it.
     */
    private allPositionsAreArb: () => boolean = () => false,
    /** current (fresh) book for a market, used to pick the bottleneck leg */
    private getBook: (marketId: string) => YesBook | undefined = () => undefined,
    /** markets owned by the market maker: not inferred/adopted as arbitrage */
    private skipMarkets: () => Set<string> = () => new Set(),
  ) {}

  /** Called for every order the engine's execution client creates. */
  capture(o: PaperOrder) {
    if (o.filledQuantity <= 0) return;
    this.queue.push({ o, queuedAt: Date.now() });
    this.stats.queue = this.queue.length;
  }

  /** Authoritative positions and cash from SIG into the engine's portfolio. */
  async reconcile(initial = false) {
    const pf = this.portfolio();
    if (!pf) return;
    const [pos, pnl] = await Promise.all([this.client.tournamentPositions(), this.client.tournamentPnl()]);
    const byExchange = new Map(this.markets().map((m) => [m.exchangeId, m.id]));
    const rows: { marketId: string; contract: Contract; quantity: number; avgEntry: number; lots: { quantity: number; price: number }[] }[] = [];
    for (const p of pos.positions) {
      if (p.settled || !p.quantity) continue;
      const marketId = byExchange.get(String(p.exchangeId)) ?? String(p.marketId);
      const contract: Contract = p.quantity > 0 ? "YES" : "NO";
      rows.push({
        marketId,
        contract,
        quantity: Math.abs(p.quantity),
        avgEntry: p.avgCost,
        lots: (p.lots ?? []).map((l) => ({ quantity: Math.abs(l.quantity), price: l.entryPrice })),
      });
    }
    const cash = round(pnl.totalAccountValue - pnl.totalHoldingsValue, 4);
    pf.syncFromExchange(rows, cash, new Date().toISOString());
    // Drop YES locks recorded by older versions: only NO sets are arbitrage now.
    for (const k of [...pf.arb.keys()]) if (k.endsWith(":YES")) pf.arb.delete(k);
    for (const [race, ids] of [...pf.arbSets]) if (!ids.some((id) => pf.arb.has(`${id}:NO`))) pf.arbSets.delete(race);
    this.inferSets(pf);
    this.adoptLegs(pf);
    this.real = new Map(rows.map((r) => [`${r.marketId}:${r.contract}`, r.quantity]));
    this.stats.accountValue = round(pnl.totalAccountValue, 2);
    this.stats.cash = round(cash, 2);
    // SIG values NO shares near the mid, so a freshly bought set always "shows" a loss although its
    // payout is fixed. Judge drawdown on secured value: cash + guaranteed payout of complete sets +
    // market value of everything else.
    // Per-share value of what is held, from SIG's own marketValue (currentPrice is the YES price,
    // which would overvalue NO shares).
    const price = new Map(pos.positions.map((p) => [`${byExchange.get(String(p.exchangeId)) ?? p.marketId}:${p.quantity > 0 ? "YES" : "NO"}`, p.quantity ? Math.abs(p.marketValue / p.quantity) : p.avgCost]));
    let secured = cash;
    const counted = new Map<string, number>();
    for (const [race, ids] of pf.arbSets) {
      void race;
      const q = Math.min(...ids.map((id) => pf.holdings(id).NO));
      if (q > 0 && ids.length > 1) {
        secured += q * (ids.length - 1);
        for (const id of ids) counted.set(`${id}:NO`, q);
      }
    }
    for (const r of rows) secured += Math.max(0, r.quantity - (counted.get(`${r.marketId}:${r.contract}`) ?? 0)) * (price.get(`${r.marketId}:${r.contract}`) ?? r.avgEntry);
    this.stats.securedValue = round(secured, 2);
    if (initial || this.stats.startValue === null) this.stats.startValue = this.stats.securedValue;
    const dd = this.stats.startValue ? 1 - secured / this.stats.startValue : 0;
    if (dd >= config.liveMaxDrawdown && !this.stats.halted) {
      this.stats.halted = `secured value ${this.stats.securedValue} is ${(dd * 100).toFixed(1)}% below start ${this.stats.startValue}`;
      log("ERROR", "live", "halted_new_entries", { reason: this.stats.halted });
    }
    this.lastReconcile = Date.now();
    this.stats.lastReconcileAt = new Date().toISOString();
    this.onReconciled();
  }

  private raceOf(marketId: string): string {
    const m = this.markets().find((x) => x.id === marketId);
    return m?.race ? raceId(m.race) : marketId;
  }

  private raceLegs(marketId: string): string[] {
    const r = this.raceOf(marketId);
    return this.markets().filter((m) => m.race && raceId(m.race) === r).map((m) => m.id);
  }

  /**
   * Positions held as a complete set (NO on every listed outcome of a race, or YES on every one)
   * are arbitrage even if local records were lost (restart, manual trades): lock them as a set.
   */
  private inferSets(pf: Portfolio) {
    const byRace = new Map<string, SigMarket[]>();
    for (const m of this.markets()) if (m.race) byRace.set(raceId(m.race), [...(byRace.get(raceId(m.race)) ?? []), m]);
    const skip = this.skipMarkets();
    for (const [race, members] of byRace) {
      if (members.length < 2 || pf.arbSets.has(race) || members.some((m) => skip.has(m.id))) continue;
      // Mixed YES/NO holdings are a directional position, not a set: never adopt them.
      if (members.some((m) => pf.holdings(m.id).YES > 0) && members.some((m) => pf.holdings(m.id).NO > 0)) continue;
      // Only buy-all-NO sets exist (buy-all-YES is off): never adopt YES holdings as a set.
      for (const c of ["NO"] as Contract[]) {
        const free = members.map((m) => pf.freeHoldings(m.id)[c]);
        const need = this.allPositionsAreArb() ? Math.max(...free) : Math.min(...free);
        if (need < 1) continue;
        // Lock EVERY share of each leg, not just the matched part: unequal legs are then balanced by
        // the engine's leg repair (complete or trim, whichever is worth more).
        for (const [i, m] of members.entries()) {
          const p = pf.get(m.id, c);
          if (!p || free[i] < 1) continue;
          pf.markArb(m.id, c, free[i], free[i] * p.avgEntry);
          p.tradeType = "arbitrage";
        }
        pf.arbSets.set(race, members.map((m) => m.id));
        log("WARNING", "live", "arb_set_inferred", { raceId: race, contract: c, legs: free });
      }
    }
  }

  /** Shares bought outside a set's lock (late fills, earlier versions) on a race that has a set: lock them too. */
  private adoptLegs(pf: Portfolio) {
    for (const ids of pf.arbSets.values())
      for (const id of ids)
        for (const c of ["NO", "YES"] as Contract[]) {
          const extra = pf.freeHoldings(id)[c];
          const p = pf.get(id, c);
          if (extra > 0 && p && pf.arbQty(id, c) > 0) {
            pf.markArb(id, c, extra, extra * p.avgEntry);
            p.tradeType = "arbitrage";
          }
        }
  }

  /**
   * Sell EVERY position at the best prices available (no profit floor), walking each book as deep
   * as needed. Several passes; anything the books cannot absorb is reported and retried later.
   */
  async liquidateAll(passes = 4): Promise<number> {
    const pf = this.portfolio();
    if (!pf) return -1;
    const exchangeOf = new Map(this.markets().map((m) => [m.id, m.exchangeId]));
    let left = 0;
    for (let pass = 0; pass < passes; pass++) {
      await this.reconcile();
      const positions = pf.positions();
      left = positions.length;
      if (!left) break;
      // Books move while SIG answers slowly: price below the walked level, more on each pass.
      const slack = [0.02, 0.05, 0.1, 0.2][Math.min(pass, 3)];
      const sellOne = async (p: (typeof positions)[number]) => {
        const ex = exchangeOf.get(p.marketId);
        if (!ex) return;
        const fresh = await this.client.orderbook(p.marketId, this.tournamentId, 50).catch(() => null);
        const b = fresh ?? this.getBook(p.marketId);
        if (!b) return;
        const action = p.contract === "YES" ? "SELL_YES" : "SELL_NO";
        const levels = contractLevels(b, action);
        if (!levels.length) return;
        let need = p.quantity;
        let limit = levels[0].price;
        for (const lv of levels) {
          limit = lv.price;
          need -= lv.quantity;
          if (need <= 0) break;
        }
        limit = Math.max(0.005, limit - slack);
        const qty = Math.floor(Math.min(p.quantity, this.real.get(`${p.marketId}:${p.contract}`) ?? 0));
        if (qty <= 0) return;
        try {
          const r = await this.client.placeOrder({ exchangeId: ex, side: p.contract === "YES" ? "yes" : "no", action: "sell", quantity: qty, price: onTick(limit, "down"), tournamentId: this.tournamentId, idempotencyKey: `liq-${randomUUID()}` });
          if (r.open && r.orderId) await this.client.cancelOrder(r.orderId).catch(() => undefined);
          log("WARNING", "live", "liquidate", { pass, marketId: p.marketId, contract: p.contract, quantity: qty, limit: round(limit, 3), freshBook: !!fresh, filled: r.quantityTraded, fillPrice: r.fillPrice, costBasis: round(qty * p.avgEntry, 2) });
        } catch (e) {
          this.fail("liquidate_failed", e, { marketId: p.marketId });
        }
      };
      // SIG takes ~30 s per call: work several positions at once (the write limiter still caps the rate).
      const todo = [...positions];
      await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
        for (let p = todo.shift(); p; p = todo.shift()) await sellOne(p);
      }));
    }
    await this.reconcile();
    pf.arb.clear();
    pf.arbSets.clear();
    left = pf.positions().length;
    log("WARNING", "live", "liquidation_done", { positionsLeft: left, cash: this.stats.cash, accountValue: this.stats.accountValue });
    return left;
  }

  /** Send everything queued (exits first), then reconcile. Never runs concurrently. */
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = this.queue.splice(0);
      this.stats.queue = 0;
      // Entries decided on an older book than the newest batch are superseded: drop them.
      const newest = Math.max(0, ...pending.filter((p) => !isExit(p.o)).map((p) => p.queuedAt));
      for (let i = pending.length - 1; i >= 0; i--)
        if (!isExit(pending[i].o) && !/^arbitrage:arbitrage/.test(pending[i].o.tag ?? "") && pending[i].queuedAt < newest - 1000) {
          pending.splice(i, 1);
          this.stats.dropped++;
        }
      if (pending.length) {
        // Group legs of the same set; exits/unwinds/repairs first, then entries in queue order.
        const groups = new Map<string, Pending[]>();
        for (const p of pending) {
          const k = p.o.group ?? p.o.orderId;
          groups.set(k, [...(groups.get(k) ?? []), p]);
        }
        // Repairs re-decided on later ticks supersede earlier ones for the same race.
        const latestRepair = new Map<string, string>();
        for (const [k, g] of groups) if (/:repair/.test(g[0].o.tag ?? "")) latestRepair.set(this.raceOf(g[0].o.marketId), k);
        for (const [k, g] of [...groups]) if (/:repair/.test(g[0].o.tag ?? "") && latestRepair.get(this.raceOf(g[0].o.marketId)) !== k) {
          groups.delete(k);
          this.stats.dropped += g.length;
        }
        const ordered = [...groups.values()].sort((a, b) => Number(!a.some((x) => isExit(x.o))) - Number(!b.some((x) => isExit(x.o))));
        for (const g of ordered) {
          const exit = g.some((x) => isExit(x.o));
          // Arbitrage sets are re-checked on fresh books just before sending (sendSequential), so age
          // alone does not invalidate them; with SIG answering in 30-60 s it dropped every set.
          const arbSet = g.length > 1 && g.every((x) => /^arbitrage:arbitrage/.test(x.o.tag ?? ""));
          const stale = !arbSet && Date.now() - g[0].queuedAt > config.liveMaxOrderAgeSec * 1000;
          if (!exit && (this.stats.halted || stale || this.client.writes.available() <= 1)) {
            this.stats.dropped += g.length;
            log("WARNING", "live", "entry_dropped", { group: g[0].o.group, legs: g.length, reason: this.stats.halted ? "halted" : stale ? "stale" : "write_budget", ageSec: Math.round((Date.now() - g[0].queuedAt) / 1000) });
            continue;
          }
          // A resting remainder could fill later and unbalance a set: send() cancels its own
          // remainders by id (cancel-all would also pull the swing catcher's resting orders).
          await this.send(g.map((x) => x.o));
        }
      }
      const due = pending.length || Date.now() - this.lastReconcile > config.liveReconcileSec * 1000;
      const overdue = Date.now() - this.lastReconcile > 3 * config.liveReconcileSec * 1000;
      // Orders captured while this batch was in flight still have to be sent; reconciling now
      // would erase their (paper) positions and let the engine decide them a second time.
      if (due && (!this.queue.length || overdue)) await this.reconcile();
    } catch (e) {
      this.fail("flush_failed", e);
    } finally {
      this.stats.writesLastMinute = this.client.writes.usedLastMinute();
      this.busy = false;
    }
  }

  /** Mirror one group of paper orders. Returns true when any order may still be resting. */
  private async send(orders: PaperOrder[]): Promise<boolean> {
    const exchangeOf = new Map(this.markets().map((m) => [m.id, m.exchangeId]));
    const legs: { o: PaperOrder; input: OrderInput }[] = [];
    for (const o of orders) {
      const buy = o.action.startsWith("BUY");
      const contract = o.contract;
      const px = o.worstPrice ?? o.limitPrice ?? o.fillPrice;
      if (px === null || px === undefined) continue;
      const price = onTick(px, buy ? "up" : "down");
      let qty = Math.floor(o.filledQuantity);
      if (!buy) qty = Math.min(qty, Math.floor(this.real.get(`${o.marketId}:${contract}`) ?? 0));
      if (/:repair/.test(o.tag ?? "")) {
        // A repair may only close the imbalance that REALLY exists right now.
        const legs = this.raceLegs(o.marketId).map((id) => this.real.get(`${id}:${contract}`) ?? 0);
        const mine = this.real.get(`${o.marketId}:${contract}`) ?? 0;
        qty = Math.min(qty, Math.floor(buy ? Math.max(...legs) - mine : mine - Math.min(...legs)));
      }
      qty = Math.min(qty, Math.floor(config.liveMaxOrderNotional / Math.max(price, 0.005)));
      const exchangeId = exchangeOf.get(o.marketId);
      if (!exchangeId || qty <= 0) continue;
      legs.push({ o, input: { exchangeId, side: contract === "YES" ? "yes" : "no", action: buy ? "buy" : "sell", quantity: qty, price, tournamentId: this.tournamentId } });
    }
    if (!legs.length) return false;
    // A set's legs must stay equal: size every leg to the smallest.
    if (legs.length > 1 && !/:repair/.test(legs[0].o.tag ?? "")) {
      const q = Math.min(...legs.map((l) => l.input.quantity));
      for (const l of legs) l.input.quantity = q;
    }
    const entrySet = legs.length > 1 && legs.every((l) => l.input.action === "buy") && /^arbitrage:arbitrage/.test(legs[0].o.tag ?? "");
    if (entrySet) return this.sendSequential(legs);
    const key = `pc-${randomUUID()}`;
    this.stats.ordersSent += legs.length;
    let results: OrderResult[];
    try {
      results = legs.length > 1 && legs.length <= 10
        ? (await this.client.placeMultiLeg(legs.map((l) => l.input), key)).results.sort((a, b) => a.index - b.index).map((r) => r.data)
        : [await this.client.placeOrder({ ...legs[0].input, idempotencyKey: key })];
    } catch (e) {
      // 409 REQUEST_IN_FLIGHT: SIG is still executing it; the outcome arrives via reconcile.
      if (e instanceof SigApiError && e.status === 409) {
        this.lastReconcile = 0;
        log("WARNING", "live", "order_in_flight", { legs: legs.map((l) => l.input) });
        return true;
      }
      this.fail("order_failed", e, { legs: legs.map((l) => l.input) });
      return false;
    }
    let open = false;
    const openIds: number[] = [];
    results.forEach((r, i) => {
      if (r.open && r.orderId) openIds.push(r.orderId);
      const l = legs[i];
      const filled = Number(r.quantityTraded ?? 0);
      if (filled > 0) {
        this.stats.ordersFilled++;
        this.stats.sharesFilled += filled;
        const k = `${l.o.marketId}:${l.o.contract}`;
        this.real.set(k, (this.real.get(k) ?? 0) + (l.input.action === "buy" ? filled : -filled));
      }
      if (r.open) open = true;
      log("INFO", "live", "order", {
        marketId: l.o.marketId,
        tag: l.o.tag,
        side: l.input.side,
        action: l.input.action,
        quantity: l.input.quantity,
        limit: l.input.price,
        filled,
        fillPrice: r.fillPrice,
        open: r.open,
        paperFilled: l.o.filledQuantity,
        orderId: r.orderId,
      });
    });
    for (const id of openIds) await this.client.cancelOrder(id).catch((e) => this.fail("cancel_failed", e, { orderId: id }));
    return open;
  }

  /**
   * Arbitrage entry, one leg at a time. Live, SIG answers in 10-20 s and other bots take the cheap
   * leg meanwhile, so a simultaneous multi-leg request filled legs unevenly (TX-15: 424 vs 124).
   *  1. Buy the BOTTLENECK leg first (least depth at its limit relative to the size).
   *  2. Every next leg buys exactly the quantity filled so far, with a limit that still keeps the
   *     whole set profitable: payout - prices paid - planned prices of the remaining legs - 0.1pp.
   *  3. Each leg's unfilled remainder is cancelled before the next leg.
   * A leg that cannot be completed profitably is left to leg repair (complete or trim by value).
   */
  private async sendSequential(legs: { o: PaperOrder; input: OrderInput }[]): Promise<boolean> {
    const payout = legs[0].input.side === "no" ? legs.length - 1 : 1;
    // Re-check the set on FRESH books: equal shares on every leg, sized to the depth that is still
    // profitable together, each leg's limit at the deepest level that size walks to. The engine's
    // cached books are net of our own simulated fill, so only fresh books for EVERY leg re-size;
    // otherwise the engine's plan is sent (still capped at break-even below).
    const fresh = new Map<string, YesBook>();
    await Promise.all(
      legs.map(async (l) => {
        const b = await this.client.orderbook(l.o.marketId, this.tournamentId, 50).catch(() => null);
        if (b) fresh.set(l.o.marketId, b);
      }),
    );
    const bookOf = (id: string) => fresh.get(id) ?? this.getBook(id);
    if (fresh.size === legs.length) {
      const sized = sizeSet(legs.map((l) => ({ marketId: l.o.marketId, action: l.o.action, book: fresh.get(l.o.marketId)! })), payout, Math.min(...legs.map((l) => l.input.quantity)), 0.002);
      if (!sized || sized.q < 1) {
        log("WARNING", "live", "entry_skipped", { reason: "gone_on_fresh_book", markets: legs.map((l) => l.o.marketId) });
        return false;
      }
      for (const l of legs) {
        let left = sized.q;
        let worst = 0;
        for (const lv of contractLevels(fresh.get(l.o.marketId)!, l.o.action)) {
          worst = lv.price;
          left -= lv.quantity;
          if (left <= 0) break;
        }
        l.input.quantity = Math.floor(sized.q);
        l.input.price = onTick(worst, "up");
      }
      log("INFO", "live", "entry_resized", { markets: legs.map((l) => l.o.marketId), sets: Math.floor(sized.q), costPerSet: round(sized.cost / sized.q, 4), profit: round(sized.q * payout - sized.cost, 2) });
    } else log("INFO", "live", "entry_planned", { markets: legs.map((l) => l.o.marketId), sets: Math.min(...legs.map((l) => l.input.quantity)), freshBooks: fresh.size });
    const ratio = (l: { o: PaperOrder; input: OrderInput }) => {
      const b = bookOf(l.o.marketId);
      if (!b) return 1;
      return availableQuantity(b, l.o.action, l.input.price) / Math.max(1, l.input.quantity);
    };
    const order = [...legs].sort((a, b) => ratio(a) - ratio(b));
    let qty = order[0].input.quantity;
    let paid = 0; // per-set price paid on legs filled so far
    for (let i = 0; i < order.length && qty >= 1; i++) {
      const l = order[i];
      const laterPlanned = order.slice(i + 1).reduce((s, x) => s + (x.input.price ?? 0), 0);
      // Marketable limits (they take the best available prices at once, like a market order) capped
      // at the price that still leaves the whole set profitable. The first leg may pay up to half
      // of the planned profit more than planned; later legs up to break-even + 0.1pp.
      const planned = order.reduce((s, x) => s + (x.input.price ?? 0), 0);
      const slack = Math.max(0, payout - planned - 0.002);
      const cap =
        i === 0
          ? Math.max(l.input.price!, onTick(l.input.price! + (this.aggressive ? slack : slack / 2), "down"))
          : onTick(payout - paid - laterPlanned - 0.001, "down");
      if (cap < 0.005) break;
      const input = { ...l.input, quantity: Math.floor(qty), price: Math.max(cap, 0.005) };
      this.stats.ordersSent++;
      let r: OrderResult;
      try {
        r = await this.client.placeOrder({ ...input, idempotencyKey: `pc-${randomUUID()}` });
      } catch (e) {
        if (e instanceof SigApiError && e.status === 409) this.lastReconcile = 0;
        this.fail("order_failed", e, { leg: input });
        return true;
      }
      const filled = Number(r.quantityTraded ?? 0);
      if (r.open && r.orderId) await this.client.cancelOrder(r.orderId).catch((e) => this.fail("cancel_failed", e));
      log("INFO", "live", "order", { marketId: l.o.marketId, tag: l.o.tag, step: i + 1, of: order.length, side: input.side, action: input.action, quantity: input.quantity, limit: input.price, filled, fillPrice: r.fillPrice, open: r.open, orderId: r.orderId });
      if (filled > 0) {
        this.stats.ordersFilled++;
        this.stats.sharesFilled += filled;
        const k = `${l.o.marketId}:${l.o.contract}`;
        this.real.set(k, (this.real.get(k) ?? 0) + filled);
        paid += r.fillPrice ?? input.price ?? 0;
      }
      qty = Math.min(qty, filled);
    }
    return false;
  }

  private fail(event: string, e: unknown, ctx: Record<string, unknown> = {}) {
    this.stats.errors++;
    this.stats.lastError = `${event}: ${String(e)}`.slice(0, 300);
    log("ERROR", "live", event, { error: String(e), status: e instanceof SigApiError ? e.status : undefined, ...ctx });
  }
}
