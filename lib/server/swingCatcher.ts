import { randomUUID } from "node:crypto";
import { config } from "./config";
import { log } from "./log";
import { kvGet, kvSet } from "./db";
import { SigApiError, type SigClient } from "./sigClient";
import type { Contract, SigMarket, YesBook } from "../core/types";
import { round } from "../core/orderbook";
import { raceId } from "../core/races";

// Swing catcher: deep resting orders, like the large "walls" other bots leave in the book.
//
// On a few liquid markets we rest a YES bid SWING_DIST below the mid and a NO bid SWING_DIST
// below the NO mid (= a YES ask SWING_DIST above it). They only fill when a large order sweeps
// the book; ~40-45% of such jumps revert, so the fill is then sold back:
//   take profit  - the contract's bid is SWING_DIST/2 above our entry
//   time exit    - after SWING_HOLD_MIN minutes, at the bid (limit 1pp below)
//   stop         - the bid is 2 x SWING_DIST below our entry (a real news move, not a swing)
// Backtest on 15 h of recorded SIG books (2 Oct): D = 5pp -> 10-23 fills, +2.5pp per share after
// paying the spread to exit 1 h later; D = 3pp -> 94 fills, +1.1pp. Small sample with no news
// shock in it, so orders are small (SWING_NOTIONAL each) and total capital is capped.
//
// One position per market at a time (the other quote is pulled on a fill). Markets of races the
// arbitrage engine holds are never quoted; markets with a swing position are excluded from the
// arbitrage engine and from arbitrage inference on reconcile. Positions survive restarts (kv).

const TICK = 0.005;
const down = (p: number) => round(Math.max(TICK, Math.floor(p / TICK + 1e-9) * TICK), 3);

interface Rest {
  orderId: number;
  contract: Contract; // YES bid, or NO bid (= YES ask)
  price: number; // contract terms
  remaining: number;
  anchor: number; // YES mid when placed
  placedAt: number;
}

interface Pos {
  contract: Contract;
  qty: number;
  avg: number; // contract terms
  at: number;
}

interface St {
  m: SigMarket;
  yes: Rest | null;
  no: Rest | null;
}

export interface SwingStats {
  status: "idle" | "running";
  markets: { id: string; title: string; mid: number | null; yesBid: number | null; noBid: number | null; pos: string | null }[];
  fills: number;
  exits: number;
  realized: number;
  reserved: number;
  writes: number;
  lastError: string | null;
}

export class SwingCatcher {
  private s = new Map<string, St>();
  private pos = new Map<string, Pos>(kvGet<[string, Pos][]>("swing_positions", []));
  private lastSelect = 0;
  stats: SwingStats = { status: "idle", markets: [], fills: 0, exits: 0, realized: 0, reserved: 0, writes: 0, lastError: null };

  constructor(
    private client: SigClient,
    private tournamentId: string,
    private markets: () => SigMarket[],
    private getBook: (marketId: string) => YesBook | undefined,
    /** races the arbitrage engine holds: never quoted */
    private busyRaces: () => Set<string>,
    /** shares really held on SIG (after reconcile) */
    private held: (marketId: string, contract: Contract) => number,
    /** cash available to the whole account */
    private accountValue: () => number,
  ) {
    const saved = kvGet<Partial<SwingStats> | null>("swing_stats", null);
    if (saved) Object.assign(this.stats, { fills: saved.fills ?? 0, exits: saved.exits ?? 0, realized: saved.realized ?? 0 });
  }

  /** Markets with a swing position: excluded from the arbitrage engine and inference. */
  owned(): Set<string> {
    return new Set(this.pos.keys());
  }

  /** Cash committed to resting swing bids (the arbitrage engine must not spend it). */
  reserved(): number {
    let r = 0;
    for (const st of this.s.values()) for (const q of [st.yes, st.no]) if (q) r += q.remaining * q.price;
    return round(r, 2);
  }

  private writeOk() {
    return this.client.writes.available() > config.swingWritesReserve;
  }

  private top(id: string) {
    const b = this.getBook(id);
    const bid = b?.bids[0]?.price;
    const ask = b?.asks[0]?.price;
    if (!b || bid === undefined || ask === undefined || ask <= bid) return null;
    return { bid, ask, mid: (bid + ask) / 2, book: b };
  }

  async cycle() {
    try {
      this.stats.status = "running";
      await this.syncFills();
      await this.manageExits();
      // Full rescan every 10 min; every minute while short of markets (books still loading after a
      // restart, or quoted races taken by arbitrage).
      const short = [...this.s.keys()].filter((id) => !this.pos.has(id)).length < config.swingMarkets;
      if (Date.now() - this.lastSelect > (short ? 60_000 : 10 * 60_000)) this.select();
      await this.quoteAll();
    } catch (e) {
      this.stats.lastError = String(e).slice(0, 200);
      log("ERROR", "swing", "cycle_failed", { error: String(e) });
    }
    this.refresh();
  }

  /** The most liquid tight markets, one per race, away from races the arbitrage engine holds. */
  private select() {
    this.lastSelect = Date.now();
    const busy = this.busyRaces();
    const keep = new Set([...this.s.keys()].filter((id) => !this.pos.has(id)));
    const cands: { m: SigMarket; depth: number }[] = [];
    for (const m of this.markets()) {
      if (!m.race || busy.has(raceId(m.race)) || this.pos.has(m.id)) continue;
      const t = this.top(m.id);
      if (!t || t.book.topOnly || t.ask - t.bid > config.swingMaxSpread + 1e-9 || t.mid < 0.15 || t.mid > 0.85) continue;
      const near = (levels: { price: number; quantity: number }[]) => levels.filter((l) => Math.abs(l.price - t.mid) <= 0.03).reduce((s, l) => s + l.quantity, 0);
      cands.push({ m, depth: Math.min(near(t.book.bids), near(t.book.asks)) });
    }
    cands.sort((a, b) => b.depth - a.depth);
    const races = new Set<string>();
    const pick = new Set<string>();
    for (const c of cands) {
      if (pick.size >= config.swingMarkets) break;
      const r = raceId(c.m.race!);
      if (races.has(r)) continue;
      races.add(r);
      pick.add(c.m.id);
      if (!this.s.has(c.m.id)) this.s.set(c.m.id, { m: c.m, yes: null, no: null });
    }
    // Markets that dropped out are cancelled by quoteAll (they are no longer wanted).
    for (const id of keep) if (!pick.has(id)) (this.s.get(id) as St & { drop?: boolean }).drop = true;
  }

  /** Resting orders that left the open list (and we did not cancel) were filled. */
  private async syncFills() {
    const tracked = [...this.s.values()].flatMap((st) => [st.yes, st.no].filter((q): q is Rest => Boolean(q)).map((q) => ({ st, q })));
    if (!tracked.length) return;
    const open = await this.client.openOrders(this.tournamentId);
    const byId = new Map(open.map((o) => [Number(o.id), o]));
    for (const { st, q } of tracked) {
      let o: { quantity: number; open: boolean } | undefined = byId.get(q.orderId);
      if (!o) o = await this.client.getOrder(q.orderId).catch(() => undefined);
      if (!o) continue;
      const remaining = Math.abs(Number(o.quantity ?? 0));
      this.applyFill(st, q, q.remaining - remaining);
      q.remaining = remaining;
      if (!o.open || remaining <= 0) this.clear(st, q.contract);
    }
  }

  private clear(st: St, c: Contract) {
    if (c === "YES") st.yes = null;
    else st.no = null;
  }

  private applyFill(st: St, q: Rest, qty: number) {
    if (qty < 1) return;
    const p = this.pos.get(st.m.id);
    if (p && p.contract === q.contract) {
      p.avg = (p.avg * p.qty + q.price * qty) / (p.qty + qty);
      p.qty += qty;
    } else this.pos.set(st.m.id, { contract: q.contract, qty, avg: q.price, at: Date.now() });
    this.stats.fills++;
    this.save();
    log("WARNING", "swing", "fill", { marketId: st.m.id, contract: q.contract, price: q.price, qty, anchorMid: q.anchor, mid: this.top(st.m.id)?.mid ?? null });
  }

  private async cancel(st: St, q: Rest) {
    this.stats.writes++;
    try {
      await this.client.cancelOrder(q.orderId);
    } catch (e) {
      if (!(e instanceof SigApiError && (e.status === 404 || e.status === 409))) throw e;
    }
    try {
      const o = await this.client.getOrder(q.orderId);
      this.applyFill(st, q, q.remaining - Math.abs(Number(o.quantity ?? 0)));
    } catch {
      /* a late fill is picked up on reconcile at worst */
    }
    this.clear(st, q.contract);
  }

  /** Sell swing fills back: take profit on reversion, time exit, or stop on a real move. */
  private async manageExits() {
    for (const [id, p] of [...this.pos]) {
      const m = this.markets().find((x) => x.id === id);
      const t = this.top(id);
      const real = Math.floor(this.held(id, p.contract));
      if (real < 1) {
        // The portfolio only shows a fill after the next reconcile (30-60 s on slow SIG): never
        // forget a fresh fill. Only a position missing for 10+ minutes was really sold elsewhere.
        if (Date.now() - p.at > 10 * 60_000) {
          this.pos.delete(id);
          this.save();
          log("WARNING", "swing", "position_gone", { marketId: id, contract: p.contract, qty: p.qty });
        }
        continue;
      }
      if (!m || !t) continue;
      const bid = p.contract === "YES" ? t.bid : 1 - t.ask; // contract-terms best bid
      const age = (Date.now() - p.at) / 60_000;
      const reason = bid >= p.avg + config.swingDist / 2 ? "take_profit" : bid <= p.avg - 2 * config.swingDist ? "stop" : age >= config.swingHoldMin ? "time" : null;
      if (!reason || !this.writeOk()) continue;
      const limit = reason === "take_profit" ? down(bid) : down(Math.max(TICK, bid - 0.01));
      const qty = Math.min(real, Math.floor(p.qty));
      this.stats.writes++;
      try {
        const r = await this.client.placeOrder({ exchangeId: m.exchangeId, side: p.contract === "YES" ? "yes" : "no", action: "sell", quantity: qty, price: limit, tournamentId: this.tournamentId, idempotencyKey: `swing-${randomUUID()}` });
        if (r.open && r.orderId) await this.client.cancelOrder(r.orderId).catch(() => undefined);
        const filled = Number(r.quantityTraded ?? 0);
        const px = Number(r.fillPrice ?? limit);
        if (filled > 0) {
          const pnl = round(filled * (px - p.avg), 2);
          this.stats.realized = round(this.stats.realized + pnl, 2);
          this.stats.exits++;
          p.qty -= filled;
          if (p.qty < 1) this.pos.delete(id);
          this.save();
          log("WARNING", "swing", "exit", { marketId: id, reason, contract: p.contract, qty: filled, price: px, entry: round(p.avg, 4), pnl });
        }
      } catch (e) {
        this.stats.lastError = String(e).slice(0, 200);
        log("ERROR", "swing", "exit_failed", { marketId: id, error: String(e) });
      }
    }
  }

  private async quoteAll() {
    const busy = this.busyRaces();
    const cap = config.swingCapitalPct * this.accountValue();
    for (const [id, st] of [...this.s]) {
      const drop = (st as St & { drop?: boolean }).drop || (st.m.race && busy.has(raceId(st.m.race))) || this.pos.has(id);
      const t = this.top(id);
      if (drop || !t || t.ask - t.bid > 2 * config.swingMaxSpread) {
        // Not quotable now (taken by arbitrage, holding a fill, or the book blew out): pull quotes.
        for (const q of [st.yes, st.no]) if (q && this.writeOk()) await this.cancel(st, q);
        if ((st as St & { drop?: boolean }).drop && !st.yes && !st.no) this.s.delete(id);
        continue;
      }
      const want: Record<Contract, number> = { YES: down(t.mid - config.swingDist), NO: down(1 - t.mid - config.swingDist) };
      for (const c of ["YES", "NO"] as const) {
        const cur = c === "YES" ? st.yes : st.no;
        const px = want[c];
        // Re-centre when the mid moved a third of the distance, or every 30 minutes.
        const fresh = cur && Math.abs(cur.anchor - t.mid) < config.swingDist / 3 && Date.now() - cur.placedAt < 30 * 60_000;
        if (fresh) continue;
        if (cur) {
          if (!this.writeOk()) continue;
          await this.cancel(st, cur);
          if (this.pos.has(id)) break; // it filled before the cancel: no new quotes here
        }
        if (px < 0.02 || !this.writeOk()) continue;
        const qty = Math.floor(config.swingNotional / px);
        if (qty < 10 || this.reserved() + qty * px > cap) continue;
        this.stats.writes++;
        try {
          const r = await this.client.placeOrder({ exchangeId: st.m.exchangeId, side: c === "YES" ? "yes" : "no", action: "buy", quantity: qty, price: px, tournamentId: this.tournamentId, idempotencyKey: `swing-${randomUUID()}` });
          const q: Rest = { orderId: Number(r.orderId), contract: c, price: px, remaining: qty, anchor: t.mid, placedAt: Date.now() };
          const filled = Number(r.quantityTraded ?? 0);
          if (filled > 0) this.applyFill(st, q, filled);
          // SIG reports a NO order's remainder signed in YES terms (a resting 10-share NO buy says
          // -10): use the magnitude, or the order goes untracked and is placed again every cycle.
          q.remaining = Math.abs(Number(r.remainingQuantity ?? qty - filled));
          if (r.open && r.orderId && q.remaining >= 1) {
            if (c === "YES") st.yes = q;
            else st.no = q;
          }
        } catch (e) {
          this.stats.lastError = String(e).slice(0, 200);
          log("ERROR", "swing", "place_failed", { marketId: id, contract: c, error: String(e) });
        }
        if (this.pos.has(id)) break;
      }
    }
  }

  private save() {
    kvSet("swing_positions", [...this.pos]);
  }

  private refresh() {
    this.stats.reserved = this.reserved();
    const ids = new Set([...this.s.keys(), ...this.pos.keys()]);
    this.stats.markets = [...ids].map((id) => {
      const st = this.s.get(id);
      const p = this.pos.get(id);
      const m = st?.m ?? this.markets().find((x) => x.id === id);
      return { id, title: m?.title ?? id, mid: this.top(id)?.mid ?? null, yesBid: st?.yes?.price ?? null, noBid: st?.no?.price ?? null, pos: p ? `${p.qty} ${p.contract} @ ${round(p.avg, 3)}` : null };
    });
    kvSet("swing_stats", this.stats);
  }
}
