import { randomUUID } from "node:crypto";
import { config } from "./config";
import { log } from "./log";
import { SigApiError, type OrderInput, type OrderResult, type SigClient } from "./sigClient";
import type { Contract, PaperOrder, SigMarket } from "../core/types";
import type { Portfolio } from "../core/portfolio";
import { round } from "../core/orderbook";
import { raceId } from "../core/races";

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
const isExit = (o: PaperOrder) => (o.tag ?? "").startsWith("exit") || (o.tag ?? "").startsWith("arbexit");

export class LiveTrader {
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
    /** called after each reconcile (the collector clears the simulator's consumption overlay) */
    private onReconciled: () => void = () => {},
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
    this.inferSets(pf);
    this.real = new Map(rows.map((r) => [`${r.marketId}:${r.contract}`, r.quantity]));
    this.stats.accountValue = round(pnl.totalAccountValue, 2);
    this.stats.cash = round(cash, 2);
    if (initial || this.stats.startValue === null) this.stats.startValue = this.stats.accountValue;
    const dd = this.stats.startValue ? 1 - this.stats.accountValue / this.stats.startValue : 0;
    if (dd >= config.liveMaxDrawdown && !this.stats.halted) {
      this.stats.halted = `account value ${this.stats.accountValue} is ${(dd * 100).toFixed(1)}% below start ${this.stats.startValue}`;
      log("ERROR", "live", "halted_new_entries", { reason: this.stats.halted });
    }
    this.lastReconcile = Date.now();
    this.stats.lastReconcileAt = new Date().toISOString();
    this.onReconciled();
  }

  /**
   * Positions held as a complete set (NO on every listed outcome of a race, or YES on every one)
   * are arbitrage even if local records were lost (restart, manual trades): lock them as a set.
   */
  private inferSets(pf: Portfolio) {
    const byRace = new Map<string, SigMarket[]>();
    for (const m of this.markets()) if (m.race) byRace.set(raceId(m.race), [...(byRace.get(raceId(m.race)) ?? []), m]);
    for (const [race, members] of byRace) {
      if (members.length < 2 || pf.arbSets.has(race)) continue;
      for (const c of ["NO", "YES"] as Contract[]) {
        const free = members.map((m) => pf.freeHoldings(m.id)[c]);
        const q = Math.min(...free);
        if (q < 1) continue;
        for (const m of members) {
          const p = pf.get(m.id, c)!;
          pf.markArb(m.id, c, q, q * p.avgEntry);
          p.tradeType = "arbitrage";
        }
        pf.arbSets.set(race, members.map((m) => m.id));
        log("WARNING", "live", "arb_set_inferred", { raceId: race, contract: c, sets: q });
      }
    }
  }

  /** Send everything queued (exits first), then reconcile. Never runs concurrently. */
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = this.queue.splice(0);
      this.stats.queue = 0;
      if (pending.length) {
        // Group legs of the same set; exits/unwinds/repairs first, then entries in queue order.
        const groups = new Map<string, Pending[]>();
        for (const p of pending) {
          const k = p.o.group ?? p.o.orderId;
          groups.set(k, [...(groups.get(k) ?? []), p]);
        }
        const ordered = [...groups.values()].sort((a, b) => Number(!a.some((x) => isExit(x.o))) - Number(!b.some((x) => isExit(x.o))));
        let anyOpen = false;
        for (const g of ordered) {
          const exit = g.some((x) => isExit(x.o));
          if (!exit && (this.stats.halted || Date.now() - g[0].queuedAt > config.liveMaxOrderAgeSec * 1000 || this.client.writes.available() <= 1)) {
            this.stats.dropped += g.length;
            continue;
          }
          anyOpen = (await this.send(g.map((x) => x.o))) || anyOpen;
        }
        if (anyOpen) {
          try {
            await this.client.cancelAll(this.tournamentId);
          } catch (e) {
            this.fail("cancel_all_failed", e);
          }
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
      qty = Math.min(qty, Math.floor(config.liveMaxOrderNotional / Math.max(price, 0.005)));
      const exchangeId = exchangeOf.get(o.marketId);
      if (!exchangeId || qty <= 0) continue;
      legs.push({ o, input: { exchangeId, side: contract === "YES" ? "yes" : "no", action: buy ? "buy" : "sell", quantity: qty, price, tournamentId: this.tournamentId } });
    }
    if (!legs.length) return false;
    // A set's legs must stay equal: size every leg to the smallest.
    if (legs.length > 1) {
      const q = Math.min(...legs.map((l) => l.input.quantity));
      for (const l of legs) l.input.quantity = q;
    }
    const key = `pc-${randomUUID()}`;
    this.stats.ordersSent += legs.length;
    let results: OrderResult[];
    try {
      results = legs.length > 1 && legs.length <= 10
        ? (await this.client.placeMultiLeg(legs.map((l) => l.input), key)).results.sort((a, b) => a.index - b.index).map((r) => r.data)
        : [await this.client.placeOrder({ ...legs[0].input, idempotencyKey: key })];
    } catch (e) {
      this.fail("order_failed", e, { legs: legs.map((l) => l.input) });
      return false;
    }
    let open = false;
    results.forEach((r, i) => {
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
    return open;
  }

  private fail(event: string, e: unknown, ctx: Record<string, unknown> = {}) {
    this.stats.errors++;
    this.stats.lastError = `${event}: ${String(e)}`.slice(0, 300);
    log("ERROR", "live", event, { error: String(e), status: e instanceof SigApiError ? e.status : undefined, ...ctx });
  }
}
