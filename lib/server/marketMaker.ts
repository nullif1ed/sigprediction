import { randomUUID } from "node:crypto";
import { config } from "./config";
import { log } from "./log";
import { SigApiError, type SigClient } from "./sigClient";
import type { SigMarket, YesBook } from "../core/types";
import { round } from "../core/orderbook";
import { raceId } from "../core/races";

// Market-making EXPERIMENT (live, small, time-boxed).
//
// Quotes one tick inside the best bid/ask of a few wide-spread, actively traded markets, with
// resting limit orders on SIG, and measures what really happens: fills, spread captured, and the
// 60 s markout (did the price move against each fill?). Everything is accounted in YES terms:
// a bid fill buys YES, an ask fill sells YES (SIG turns an unbacked sell into a NO buy, which is
// the same position), P&L = cash flow + inventory x mid.
//
// Guards: one tick inside the spread but never closer than MM_MIN_EDGE to the mid, never through
// our own fair value when it is confident; size MM_SIZE per side; |inventory| <= MM_MAX_POS
// (the side that would add stops quoting) with a skew towards flat; quotes are pulled for 2 min
// when the mid moves > 2pp in a minute; MM only uses writes while the arbitrage trader keeps a
// reserve. After MM_MINUTES all quotes are cancelled, inventory is flattened (limit-protected),
// and the result is stored. Markets being quoted are excluded from the arbitrage engine.

const TICK = 0.005;
const down = (p: number) => round(Math.max(TICK, Math.floor(p / TICK + 1e-9) * TICK), 3);
const up = (p: number) => round(Math.min(1 - TICK, Math.ceil(p / TICK - 1e-9) * TICK), 3);

interface Quote {
  orderId: number;
  side: "bid" | "ask";
  price: number;
  placed: number;
  remaining: number;
}

interface Fill {
  marketId: string;
  side: "bid" | "ask";
  price: number;
  qty: number;
  at: number;
  midAtFill: number | null;
  mid60?: number | null;
}

interface MarketState {
  m: SigMarket;
  bid: Quote | null;
  ask: Quote | null;
  inv: number; // YES shares (negative = short YES = long NO)
  cash: number; // YES-terms cash flow
  mids: { at: number; mid: number }[];
  pausedUntil: number;
}

export interface MMStats {
  runId: string;
  status: "selecting" | "running" | "finished" | "failed";
  startedAt: string | null;
  endsAt: string | null;
  markets: { id: string; title: string; inv: number; pnl: number; bid: number | null; ask: number | null }[];
  fills: number;
  sharesTraded: number;
  spreadCaptured: number; // sum qty x (mid - price) for bids, (price - mid) for asks, at fill
  markout60: number; // sum qty x signed mid move 60 s after the fill (negative = adverse)
  pnl: number; // cash + inventory x mid
  writes: number;
  lastError: string | null;
}

export class MarketMaker {
  private s = new Map<string, MarketState>();
  private fills: Fill[] = [];
  private writes = 0;
  private endAt = 0;
  stats: MMStats;

  constructor(
    private client: SigClient,
    private tournamentId: string,
    private getBook: (marketId: string) => YesBook | undefined,
    private getFair: (marketId: string) => { p: number; confidence: number } | null,
    runId: string,
  ) {
    this.stats = { runId, status: "selecting", startedAt: null, endsAt: null, markets: [], fills: 0, sharesTraded: 0, spreadCaptured: 0, markout60: 0, pnl: 0, writes: 0, lastError: null };
  }

  marketIds(): Set<string> {
    return new Set(this.s.keys());
  }

  /** Pick the most promising markets: wide spread x recent traded shares, away from held races. */
  async select(markets: SigMarket[], busyRaces: Set<string>, heldMarkets: Set<string>) {
    const cands: { m: SigMarket; spread: number; mid: number }[] = [];
    for (const m of markets) {
      if (!m.race || busyRaces.has(raceId(m.race)) || heldMarkets.has(m.id)) continue;
      const b = this.getBook(m.id);
      const bid = b?.bids[0]?.price;
      const ask = b?.asks[0]?.price;
      if (!b || b.topOnly || bid === undefined || ask === undefined) continue;
      const spread = ask - bid;
      const mid = (bid + ask) / 2;
      if (spread < config.mmMinSpread - 1e-9 || mid < 0.1 || mid > 0.9) continue;
      cands.push({ m, spread, mid });
    }
    cands.sort((a, b) => b.spread - a.spread);
    const scored: { m: SigMarket; score: number; rate: number; spread: number }[] = [];
    for (const c of cands.slice(0, 10)) {
      try {
        const t = await this.client.trades(c.m.exchangeId, this.tournamentId, 50);
        const tr = t.data ?? [];
        if (tr.length < 5) continue;
        const ts = tr.map((x) => Date.parse(String((x as { createdAt?: string }).createdAt)));
        const hours = Math.max(1 / 60, (Math.max(...ts) - Math.min(...ts)) / 3_600_000);
        const shares = tr.reduce((s, x) => s + Number((x as { size?: number; quantity?: number }).size ?? x.quantity ?? 0), 0);
        const rate = shares / hours;
        scored.push({ m: c.m, score: rate * c.spread, rate, spread: c.spread });
      } catch (e) {
        this.stats.lastError = String(e).slice(0, 200);
      }
    }
    scored.sort((a, b) => b.score - a.score);
    // One market per race: quotes on both sides of a race would interact with each other.
    const races = new Set<string>();
    for (const x of scored) {
      if (this.s.size >= config.mmMarkets) break;
      const r = raceId(x.m.race!);
      if (races.has(r)) continue;
      races.add(r);
      this.s.set(x.m.id, { m: x.m, bid: null, ask: null, inv: 0, cash: 0, mids: [], pausedUntil: 0 });
    }
    this.endAt = Date.now() + config.mmMinutes * 60_000;
    this.stats.startedAt = new Date().toISOString();
    this.stats.endsAt = new Date(this.endAt).toISOString();
    this.stats.status = this.s.size ? "running" : "failed";
    if (!this.s.size) this.stats.lastError = "no market met the spread/activity criteria";
    log("WARNING", "mm", "experiment_started", { markets: scored.filter((x) => this.s.has(x.m.id)).map((x) => ({ id: x.m.id, title: x.m.title, spread: x.spread, sharesPerHour: Math.round(x.rate) })), minutes: config.mmMinutes });
  }

  get finished() {
    return this.stats.status === "finished" || this.stats.status === "failed";
  }

  /** Others' best bid/ask: our own resting quotes are removed from the book first. */
  private othersTop(st: MarketState): { bid: number | null; ask: number | null } {
    const b = this.getBook(st.m.id);
    if (!b) return { bid: null, ask: null };
    const strip = (levels: { price: number; quantity: number }[], q: Quote | null) =>
      levels.map((l) => (q && Math.abs(l.price - q.price) < 1e-9 ? { ...l, quantity: l.quantity - q.remaining } : l)).filter((l) => l.quantity > 0.5);
    return { bid: strip(b.bids, st.bid)[0]?.price ?? null, ask: strip(b.asks, st.ask)[0]?.price ?? null };
  }

  private writeOk() {
    return this.client.writes.available() > config.mmWritesReserve;
  }

  /** Refresh fills and quotes. Never runs concurrently (the collector serializes calls). */
  async cycle() {
    if (this.finished || this.stats.status === "selecting") return;
    try {
      await this.syncFills();
      this.scoreMarkouts();
      if (Date.now() >= this.endAt) return await this.finish("time_up");
      for (const st of this.s.values()) await this.quote(st);
    } catch (e) {
      this.stats.lastError = String(e).slice(0, 200);
      log("ERROR", "mm", "cycle_failed", { error: String(e) });
    }
    this.refreshStats();
  }

  /** Resting orders that disappeared from the open list (and we did not cancel) were filled. */
  private async syncFills() {
    const tracked = [...this.s.values()].flatMap((st) => [st.bid, st.ask].filter((q): q is Quote => Boolean(q)).map((q) => ({ st, q })));
    if (!tracked.length) return;
    const open = await this.client.openOrders(this.tournamentId);
    const byId = new Map(open.map((o) => [Number(o.id), o]));
    for (const { st, q } of tracked) {
      let o: { quantity: number; open: boolean } | undefined = byId.get(q.orderId);
      // The open list can lag a fresh order: confirm a missing one individually before counting it.
      if (!o) o = await this.client.getOrder(q.orderId).catch(() => undefined);
      if (!o) continue;
      const remaining = Number(o.quantity ?? 0);
      this.applyFill(st, q, q.remaining - remaining);
      q.remaining = remaining;
      if (!o.open || remaining <= 0) {
        if (q.side === "bid") st.bid = null;
        else st.ask = null;
      }
    }
  }

  private applyFill(st: MarketState, q: Quote, qty: number) {
    if (qty <= 0) return;
    const sign = q.side === "bid" ? 1 : -1;
    st.inv += sign * qty;
    st.cash -= sign * qty * q.price;
    const mid = this.mid(st);
    this.fills.push({ marketId: st.m.id, side: q.side, price: q.price, qty, at: Date.now(), midAtFill: mid });
    log("INFO", "mm", "fill", { marketId: st.m.id, side: q.side, price: q.price, qty, mid, inventory: st.inv });
  }

  private mid(st: MarketState): number | null {
    const t = this.othersTop(st);
    return t.bid !== null && t.ask !== null ? (t.bid + t.ask) / 2 : null;
  }

  private scoreMarkouts() {
    const now = Date.now();
    for (const f of this.fills) {
      if (f.mid60 !== undefined || now - f.at < 60_000) continue;
      const st = this.s.get(f.marketId);
      f.mid60 = st ? this.mid(st) : null;
    }
  }

  private async cancel(st: MarketState, q: Quote) {
    this.writes++;
    try {
      await this.client.cancelOrder(q.orderId);
    } catch (e) {
      if (!(e instanceof SigApiError && (e.status === 404 || e.status === 409))) throw e;
    }
    // A closed order reports its unfilled remainder: anything else was filled before the cancel.
    try {
      const o = await this.client.getOrder(q.orderId);
      this.applyFill(st, q, q.remaining - Number(o.quantity ?? 0));
    } catch {
      /* fills are picked up by reconcile at worst */
    }
    if (q.side === "bid") st.bid = null;
    else st.ask = null;
  }

  private async place(st: MarketState, side: "bid" | "ask", price: number, qty: number) {
    this.writes++;
    const r = await this.client.placeOrder({
      exchangeId: st.m.exchangeId,
      side: "yes",
      action: side === "bid" ? "buy" : "sell",
      quantity: qty,
      price,
      tournamentId: this.tournamentId,
      idempotencyKey: `mm-${randomUUID()}`,
    });
    // Canonical engine price is side-relative: an unbacked sell YES @p comes back as buy NO @1-p.
    const filled = Number(r.quantityTraded ?? 0);
    const q: Quote = { orderId: Number(r.orderId), side, price, placed: qty, remaining: qty };
    if (filled > 0) this.applyFill(st, q, filled);
    q.remaining = Number(r.remainingQuantity ?? qty - filled);
    if (r.open && r.orderId) {
      if (side === "bid") st.bid = q;
      else st.ask = q;
    }
  }

  private async quote(st: MarketState) {
    const now = Date.now();
    const top = this.othersTop(st);
    if (top.bid === null || top.ask === null) return;
    const mid = (top.bid + top.ask) / 2;
    st.mids.push({ at: now, mid });
    while (st.mids.length && now - st.mids[0].at > 70_000) st.mids.shift();
    // Toxic flow guard: a fast move means informed traders; step aside.
    const old = st.mids.find((x) => now - x.at >= 50_000);
    if (old && Math.abs(mid - old.mid) > 0.02) st.pausedUntil = now + 120_000;
    if (now < st.pausedUntil) {
      for (const q of [st.bid, st.ask]) if (q && this.writeOk()) await this.cancel(st, q);
      return;
    }
    const maxPos = config.mmMaxPos;
    // Inventory skew: shift both quotes towards getting flat (1 tick per half of the limit).
    const skew = -TICK * Math.round((2 * st.inv) / maxPos);
    let bid = down(Math.min(top.bid + TICK, mid - config.mmMinEdge) + skew);
    let ask = up(Math.max(top.ask - TICK, mid + config.mmMinEdge) + skew);
    const f = this.getFair(st.m.id);
    if (f && f.confidence >= 0.5) {
      bid = Math.min(bid, down(f.p - config.mmMinEdge));
      ask = Math.max(ask, up(f.p + config.mmMinEdge));
    }
    const want = {
      bid: bid < ask && st.inv < maxPos && bid < top.ask ? { price: bid, qty: Math.min(config.mmSize, maxPos - st.inv) } : null,
      ask: ask > bid && st.inv > -maxPos && ask > top.bid ? { price: ask, qty: Math.min(config.mmSize, maxPos + st.inv) } : null,
    };
    for (const side of ["bid", "ask"] as const) {
      const cur = st[side];
      const w = want[side];
      const keep = cur && w && Math.abs(cur.price - w.price) < 1e-9 && cur.remaining >= Math.min(w.qty, config.mmSize) * 0.5;
      if (keep) continue;
      if (cur) {
        if (!this.writeOk()) continue;
        await this.cancel(st, cur);
      }
      if (w && w.qty >= 10 && this.writeOk()) await this.place(st, side, w.price, Math.floor(w.qty));
    }
  }

  /** Cancel every quote, flatten inventory (limit within 1pp of the touch), store the result. */
  async finish(reason: string) {
    for (const st of this.s.values()) {
      try {
        await this.client.cancelAll(this.tournamentId, st.m.id);
      } catch (e) {
        this.stats.lastError = String(e).slice(0, 200);
      }
      for (const q of [st.bid, st.ask]) {
        if (!q) continue;
        try {
          const o = await this.client.getOrder(q.orderId);
          this.applyFill(st, q, q.remaining - Number(o.quantity ?? 0));
        } catch {
          /* ignore */
        }
      }
      st.bid = st.ask = null;
      const top = this.othersTop(st);
      if (Math.abs(st.inv) >= 1 && top.bid !== null && top.ask !== null) {
        const sell = st.inv > 0;
        const px = sell ? down(top.bid - 0.01) : up(top.ask + 0.01);
        try {
          const r = await this.client.placeOrder({ exchangeId: st.m.exchangeId, side: "yes", action: sell ? "sell" : "buy", quantity: Math.floor(Math.abs(st.inv)), price: px, tournamentId: this.tournamentId, idempotencyKey: `mm-${randomUUID()}` });
          const filled = Number(r.quantityTraded ?? 0);
          const avg = Number(r.fillPrice ?? px);
          st.inv -= (sell ? 1 : -1) * filled;
          st.cash += (sell ? 1 : -1) * filled * avg;
          if (r.open && r.orderId) await this.client.cancelOrder(r.orderId).catch(() => undefined);
          log("INFO", "mm", "flatten", { marketId: st.m.id, filled, avg, left: st.inv });
        } catch (e) {
          this.stats.lastError = String(e).slice(0, 200);
        }
      }
    }
    this.scoreMarkouts();
    this.refreshStats();
    this.stats.status = "finished";
    log("WARNING", "mm", "experiment_finished", { reason, ...this.stats });
  }

  /** Markets that must stay out of the arbitrage engine (quoted, or holding leftover inventory). */
  skip(): Set<string> {
    return new Set([...this.s.values()].filter((st) => !this.finished || Math.abs(st.inv) >= 1).map((st) => st.m.id));
  }

  private refreshStats() {
    let pnl = 0;
    const ms: MMStats["markets"] = [];
    for (const st of this.s.values()) {
      const mid = this.mid(st) ?? 0.5;
      const p = st.cash + st.inv * mid;
      pnl += p;
      ms.push({ id: st.m.id, title: st.m.title, inv: st.inv, pnl: round(p, 2), bid: st.bid?.price ?? null, ask: st.ask?.price ?? null });
    }
    let spread = 0;
    let mark = 0;
    for (const f of this.fills) {
      const sign = f.side === "bid" ? 1 : -1;
      if (f.midAtFill !== null) spread += f.qty * sign * (f.midAtFill - f.price);
      if (f.mid60 !== undefined && f.mid60 !== null && f.midAtFill !== null) mark += f.qty * sign * (f.mid60 - f.midAtFill);
    }
    Object.assign(this.stats, {
      markets: ms,
      fills: this.fills.length,
      sharesTraded: this.fills.reduce((s, f) => s + f.qty, 0),
      spreadCaptured: round(spread, 2),
      markout60: round(mark, 2),
      pnl: round(pnl, 2),
      writes: this.writes,
    });
  }
}
