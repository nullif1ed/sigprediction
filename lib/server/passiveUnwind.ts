import { randomUUID } from "node:crypto";
import { log } from "./log";
import { SigApiError, type SigClient } from "./sigClient";
import type { SigMarket, YesBook } from "../core/types";
import type { Portfolio } from "../core/portfolio";
import { availableQuantity, contractLevels, round } from "../core/orderbook";
import { raceId } from "../core/races";

// Passive unwind of large arbitrage sets (live).
//
// A big set rarely finds enough sell-back liquidity on BOTH legs at once (TX Senate: 16k sets).
// Instead of waiting for that, rest a SELL on one leg (X) at the price that makes the whole set
// profitable given what the other leg (Y) can be sold for right now, and the moment X fills, sell
// exactly that quantity of Y. We earn the spread on X instead of paying it, and every completed
// pair of sales returns at least cost + minProfit per set.
//
//   pX >= costPerSet + minProfit - (immediate sell price of Y)
//
// Only 2-leg sets; X is the leg needing the smallest price improvement over its own immediate
// sale. The races are owned by this module while an order rests (the engine leaves them alone).

const TICK = 0.005;
const up = (p: number) => round(Math.min(1 - TICK, Math.ceil(p / TICK - 1e-9) * TICK), 3);

export interface PassiveConfig {
  minSets: number; // only sets at least this large
  maxSetsPerOrder: number;
  maxGapPp: number; // rest only when X needs at most this improvement over its immediate sale
  minProfitPp: number; // per set, after both sales
  maxRaces: number;
  writesReserve: number;
}
export const DEFAULT_PASSIVE: PassiveConfig = { minSets: 500, maxSetsPerOrder: 3000, maxGapPp: 0.02, minProfitPp: 0.002, maxRaces: 3, writesReserve: 6 };

interface Resting {
  race: string;
  x: SigMarket;
  y: SigMarket;
  orderId: number;
  price: number; // NO sell price on X
  yLimit: number; // min NO sell price on Y that keeps the pair profitable
  qty: number;
  remaining: number;
  placedAt: number;
}

export interface PassiveStats {
  resting: { race: string; leg: string; price: number; qty: number; remaining: number; yLimit: number }[];
  pairsSold: number;
  setsClosed: number;
  profit: number;
  writes: number;
  lastError: string | null;
}

export class PassiveUnwinder {
  private rest = new Map<string, Resting>();
  stats: PassiveStats = { resting: [], pairsSold: 0, setsClosed: 0, profit: 0, writes: 0, lastError: null };

  constructor(
    private client: SigClient,
    private tournamentId: string,
    private markets: () => SigMarket[],
    private portfolio: () => Portfolio | null,
    private getBook: (marketId: string) => YesBook | undefined,
    private cfg: PassiveConfig = DEFAULT_PASSIVE,
  ) {}

  /** Markets the engine must not touch (a passive sell is resting on their race). */
  owned(): Set<string> {
    return new Set([...this.rest.values()].flatMap((r) => [r.x.id, r.y.id]));
  }

  private writeOk() {
    return this.client.writes.available() > this.cfg.writesReserve;
  }

  /** Immediate NO sale on a leg: best price and the shares available down to `limit`. */
  private sellNow(m: SigMarket, limit?: number) {
    const b = this.getBook(m.id);
    if (!b) return { best: null as number | null, depth: 0 };
    const best = contractLevels(b, "SELL_NO")[0]?.price ?? null;
    return { best, depth: limit === undefined ? 0 : availableQuantity(b, "SELL_NO", limit) };
  }

  async cycle() {
    const pf = this.portfolio();
    if (!pf) return;
    try {
      await this.syncFills(pf);
      await this.requote(pf);
    } catch (e) {
      this.stats.lastError = String(e).slice(0, 200);
      log("ERROR", "passive", "cycle_failed", { error: String(e) });
    }
    this.stats.resting = [...this.rest.values()].map((r) => ({ race: r.race, leg: r.x.id, price: r.price, qty: r.qty, remaining: r.remaining, yLimit: r.yLimit }));
  }

  private async syncFills(pf: Portfolio) {
    for (const r of [...this.rest.values()]) {
      const o = await this.client.getOrder(r.orderId).catch(() => undefined);
      if (!o) continue;
      const remaining = Number(o.quantity ?? 0);
      const filled = r.remaining - remaining;
      r.remaining = remaining;
      if (filled > 0) await this.completePair(pf, r, filled);
      if (!o.open || remaining <= 0) this.rest.delete(r.race);
    }
  }

  /** X sold `filled` sets: sell the same quantity of Y now, never below the profitable limit. */
  private async completePair(pf: Portfolio, r: Resting, filled: number) {
    const held = pf.holdings(r.y.id).NO;
    const qty = Math.floor(Math.min(filled, held));
    if (qty <= 0) return;
    this.stats.writes++;
    try {
      const res = await this.client.placeOrder({ exchangeId: r.y.exchangeId, side: "no", action: "sell", quantity: qty, price: r.yLimit, tournamentId: this.tournamentId, idempotencyKey: `pu-${randomUUID()}` });
      const got = Number(res.quantityTraded ?? 0);
      const avg = Number(res.fillPrice ?? r.yLimit);
      if (res.open && res.orderId) await this.client.cancelOrder(res.orderId).catch(() => undefined);
      const cost = this.costPerSet(pf, r);
      const profit = got * (r.price + avg - cost);
      this.stats.pairsSold++;
      this.stats.setsClosed += got;
      this.stats.profit = round(this.stats.profit + profit, 2);
      log("INFO", "passive", "pair_sold", { race: r.race, xSold: filled, ySold: got, xPrice: r.price, yPrice: avg, costPerSet: round(cost, 4), profit: round(profit, 2) });
      if (got < qty) log("WARNING", "passive", "y_short", { race: r.race, wanted: qty, got });
    } catch (e) {
      this.stats.lastError = String(e).slice(0, 200);
      log("ERROR", "passive", "y_sale_failed", { race: r.race, error: String(e) });
    }
  }

  private costPerSet(pf: Portfolio, r: Resting) {
    const per = (id: string) => {
      const a = pf.arb.get(`${id}:NO`);
      return a && a.quantity > 0 ? a.cost / a.quantity : (pf.get(id, "NO")?.avgEntry ?? 0);
    };
    return per(r.x.id) + per(r.y.id);
  }

  private async cancel(r: Resting) {
    this.stats.writes++;
    try {
      await this.client.cancelOrder(r.orderId);
    } catch (e) {
      if (!(e instanceof SigApiError && (e.status === 404 || e.status === 409))) throw e;
    }
    this.rest.delete(r.race);
  }

  private async requote(pf: Portfolio) {
    const ms = this.markets();
    const byId = new Map(ms.map((m) => [m.id, m]));
    const plans: { race: string; x: SigMarket; y: SigMarket; price: number; yLimit: number; qty: number; gap: number }[] = [];
    for (const [race, ids] of pf.arbSets) {
      if (ids.length !== 2) continue;
      const legs = ids.map((id) => byId.get(id)).filter((m): m is SigMarket => Boolean(m));
      if (legs.length !== 2) continue;
      const sets = Math.min(...legs.map((m) => pf.arbQty(m.id, "NO")));
      if (sets < this.cfg.minSets) continue;
      const cost = this.costPerSet(pf, { x: legs[0], y: legs[1] } as Resting);
      let best: (typeof plans)[number] | null = null;
      for (const [x, y] of [[legs[0], legs[1]], [legs[1], legs[0]]] as const) {
        const yNow = this.sellNow(y).best;
        const xNow = this.sellNow(x).best;
        if (yNow === null || xNow === null) continue;
        const price = up(cost + this.cfg.minProfitPp - yNow);
        const gap = price - xNow;
        if (gap <= 1e-9 || gap > this.cfg.maxGapPp + 1e-9) continue; // already marketable, or hopeless
        // Lowest Y price that still clears cost + minProfit (round UP: rounding down could lose).
        const yLimit = up(cost + this.cfg.minProfitPp - price);
        if (price + yLimit < cost + this.cfg.minProfitPp - 1e-9 || yLimit > yNow + 1e-9) continue;
        const yDepth = this.sellNow(y, yLimit).depth;
        const qty = Math.floor(Math.min(sets, this.cfg.maxSetsPerOrder, yDepth));
        if (qty < 100) continue;
        if (!best || gap < best.gap) best = { race, x, y, price, yLimit, qty, gap };
      }
      if (best) plans.push(best);
    }
    plans.sort((a, b) => b.qty - a.qty);
    const want = new Map(plans.slice(0, this.cfg.maxRaces).map((p) => [p.race, p]));
    for (const r of [...this.rest.values()]) {
      const p = want.get(r.race);
      const stale = !p || p.x.id !== r.x.id || Math.abs(p.price - r.price) > 1e-9 || Date.now() - r.placedAt > 10 * 60_000;
      if (stale && this.writeOk()) await this.cancel(r);
      // Keep the resting order's own Y limit up to date with the latest cost.
      else if (p) r.yLimit = p.yLimit;
    }
    for (const p of want.values()) {
      if (this.rest.has(p.race) || !this.writeOk()) continue;
      this.stats.writes++;
      const res = await this.client.placeOrder({ exchangeId: p.x.exchangeId, side: "no", action: "sell", quantity: p.qty, price: p.price, tournamentId: this.tournamentId, idempotencyKey: `pu-${randomUUID()}` });
      const r: Resting = { race: p.race, x: p.x, y: p.y, orderId: Number(res.orderId), price: p.price, yLimit: p.yLimit, qty: p.qty, remaining: p.qty, placedAt: Date.now() };
      const filled = Number(res.quantityTraded ?? 0);
      if (filled > 0) {
        r.remaining = p.qty - filled;
        await this.completePair(pf, r, filled);
      }
      if (res.open && res.orderId) this.rest.set(p.race, r);
      log("INFO", "passive", "resting_sell", { race: p.race, leg: p.x.id, price: p.price, qty: p.qty, yLimit: p.yLimit, gapPp: round(p.gap * 100, 2) });
    }
  }

  async stop() {
    for (const r of [...this.rest.values()]) await this.cancel(r).catch(() => undefined);
  }
}

export const raceOfMarket = (m: SigMarket) => (m.race ? raceId(m.race) : m.id);
