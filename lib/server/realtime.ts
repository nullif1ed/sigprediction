import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";
import { log } from "./log";
import type { SigClient } from "./sigClient";
import type { SigMarket, YesBook } from "../core/types";
import { normalizeBook } from "../core/orderbook";

// Realtime order books (SIG "tournament:{tournamentId}:market:{marketId}" channels).
//
// Every market batch carries the FULL versioned order book of the exchanges it names, so the bot
// can keep all 237 books current without spending REST reads (open Realtime connections do not
// count against the per-account budget). Delivery is best-effort: a topic revision gap, a
// `resyncRequired` batch or a reconnect marks the market for an authoritative REST refetch, which
// the collector's depth workers perform.

interface RawLevel {
  price: number;
  quantity: number;
}
interface RawBook {
  exchangeId: number | string;
  asOf?: { at: string; sequence: number } | null;
  bids?: RawLevel[];
  asks?: RawLevel[];
}

export interface RealtimeStats {
  connected: boolean;
  subscribed: number;
  markets: number;
  batches: number;
  lastBatchAt: string | null;
  resyncs: number;
  tokenExpiresAt: string | null;
}

const MARKETS_PER_CONNECTION = 80;

export class RealtimeBooks {
  private clients: SupabaseClient[] = [];
  private channels: RealtimeChannel[] = [];
  private lastRev = new Map<string, number>();
  private seq = new Map<string, number>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribed = new Set<string>();
  stats: RealtimeStats = { connected: false, subscribed: 0, markets: 0, batches: 0, lastBatchAt: null, resyncs: 0, tokenExpiresAt: null };
  /** marketId -> epoch ms of the last realtime book */
  updatedAt = new Map<string, number>();

  constructor(
    private client: SigClient,
    private onBook: (b: YesBook) => void,
    /** a market whose realtime stream may have missed an update: refetch it over REST */
    private onResync: (marketId: string) => void,
  ) {}

  async start(tournamentId: string, markets: SigMarket[]) {
    await this.stop();
    const tok = await this.client.realtimeToken();
    this.stats.tokenExpiresAt = tok.expiresAt;
    this.stats.markets = markets.length;
    const exchangeOf = new Map(markets.map((m) => [m.id, m.exchangeId]));
    for (let i = 0; i < markets.length; i += MARKETS_PER_CONNECTION) {
      const sb = createClient(tok.supabaseUrl, tok.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 100 } } });
      await sb.realtime.setAuth(tok.token);
      this.clients.push(sb);
      for (const m of markets.slice(i, i + MARKETS_PER_CONNECTION)) {
        const ch = sb
          .channel(`tournament:${tournamentId}:market:${m.id}`, { config: { private: true } })
          .on("broadcast", { event: "market_batch" }, ({ payload }) => this.onBatch(m.id, exchangeOf.get(m.id) ?? "", payload))
          .on("broadcast", { event: "book_dirty" }, () => this.resync(m.id))
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              this.subscribed.add(m.id);
              // State before the subscription is unknown: always resync once.
              this.resync(m.id);
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
              this.subscribed.delete(m.id);
              this.lastRev.delete(m.id);
            }
            this.stats.subscribed = this.subscribed.size;
            this.stats.connected = this.subscribed.size > 0;
          });
        this.channels.push(ch);
      }
    }
    // Tokens last 3 hours: re-mint (one write) and resubscribe 10 minutes before expiry.
    const ms = Math.max(60_000, Date.parse(tok.expiresAt) - Date.now() - 10 * 60_000);
    this.refreshTimer = setTimeout(() => {
      this.start(tournamentId, markets).catch((e) => log("ERROR", "realtime", "refresh_failed", { error: String(e) }));
    }, ms);
    this.refreshTimer.unref?.();
    log("INFO", "realtime", "started", { markets: markets.length, connections: this.clients.length, tokenExpiresAt: tok.expiresAt });
  }

  private resync(marketId: string) {
    this.stats.resyncs++;
    this.onResync(marketId);
  }

  private onBatch(marketId: string, exchangeId: string, payload: Record<string, unknown>) {
    this.stats.batches++;
    this.stats.lastBatchAt = new Date().toISOString();
    const delivery = (payload.delivery ?? {}) as { revision?: number; previousRevision?: number };
    const last = this.lastRev.get(marketId);
    if (typeof delivery.revision === "number") {
      if (last !== undefined && typeof delivery.previousRevision === "number" && delivery.previousRevision > last) this.resync(marketId);
      if (last === undefined || delivery.revision > last) this.lastRev.set(marketId, delivery.revision);
    }
    if (payload.resyncRequired) this.resync(marketId);
    for (const b of (payload.books ?? []) as RawBook[]) {
      if (String(b.exchangeId) !== String(exchangeId)) continue;
      // Books are versioned: never let an older book overwrite a newer one.
      const s = b.asOf?.sequence ?? 0;
      if (s && s < (this.seq.get(marketId) ?? 0)) continue;
      if (s) this.seq.set(marketId, s);
      this.updatedAt.set(marketId, Date.now());
      this.onBook(
        normalizeBook({
          exchangeId: String(b.exchangeId),
          marketId,
          bids: b.bids ?? [],
          asks: b.asks ?? [],
          asOf: b.asOf ? `${b.asOf.at}#${b.asOf.sequence}` : new Date().toISOString(),
        }),
      );
    }
  }

  /** A REST book newer than the last realtime version may replace it (and vice versa). */
  acceptRest(marketId: string, asOf: string): boolean {
    const s = Number(asOf.split("#")[1] ?? 0);
    if (!s) return true;
    if (s < (this.seq.get(marketId) ?? 0)) return false;
    this.seq.set(marketId, s);
    return true;
  }

  healthy(maxSilenceMs = 60_000): boolean {
    return this.stats.connected && this.stats.lastBatchAt !== null && Date.now() - Date.parse(this.stats.lastBatchAt) < maxSilenceMs;
  }

  async stop() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const c of this.clients) await c.removeAllChannels().catch(() => undefined);
    this.clients = [];
    this.channels = [];
    this.subscribed.clear();
    this.lastRev.clear();
    this.stats.connected = false;
    this.stats.subscribed = 0;
  }
}

export const realtimeEnabled = () => config.realtime;
