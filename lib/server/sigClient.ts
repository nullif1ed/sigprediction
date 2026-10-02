import { config } from "./config";
import { log } from "./log";
import { RateLimiter } from "./rateLimiter";
import type { Level, SigMarket, YesBook } from "../core/types";
import { normalizeBook } from "../core/orderbook";
import { parseSigTitle } from "../core/races";

// Client for the Super Market API (https://sig.thesuper.market/api/v1/docs).
// Reads use the read budget; order placement/cancel use a separate write budget. The order
// methods are not called anywhere yet: execution is still paper only.

export class SigApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

export interface RawMarket {
  id: string;
  title: string;
  status: string;
  settlementDate: string;
  settledWith: unknown;
  categories: string[];
  isComposite: boolean;
  isMultiOutcome: boolean;
  exchanges: { id: string; option: string; latestPrice: number | null; initialPrice: number | null }[];
  contexts?: { tournament: { id: string; slug: string } | null; exchanges: { id: string; latestPrice: number | null }[] }[];
}

export interface PriceSnapshot {
  exchangeId: string;
  marketId: string;
  option: string;
  latestPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
}

export interface RawNews {
  contextSummary: string | null;
  headlines: {
    url: string;
    title: string;
    source: string;
    summary: string;
    publishedDate: string;
    relevanceExplanation: string;
  }[];
  lastRefresh: string | null;
}

export interface OrderInput {
  exchangeId: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  quantity: number;
  /** limit in side-relative terms on the 0.005 tick; omit for a market order */
  price?: number;
  tournamentId?: string;
  expirationDate?: string;
}

export interface OrderResult {
  orderId: number | null;
  exchangeId: string;
  open: boolean;
  remainingQuantity?: number;
  action?: "buy" | "sell";
  side?: "yes" | "no";
  price?: number;
  quantity?: number;
  terminalReasonCode?: string | null;
  quantityTraded: number;
  totalCost: number;
  fillPrice: number | null;
}

export interface TournamentPosition {
  exchangeId: string;
  marketId: string;
  marketTitle: string;
  settled: boolean;
  /** positive = YES shares, negative = NO shares */
  quantity: number;
  avgCost: number;
  currentPrice: number | null;
  marketValue: number;
  costBasis: number;
  lots: { lotId: string; side: string; quantity: number; entryPrice: number; openedAt: string }[];
}

export interface Tournament {
  id: string;
  slug: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
  initialBalance: number;
  currencyName: string;
}

type FetchFn = typeof fetch;

export interface SigClientOptions {
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  fetchFn?: FetchFn;
  readsPerMinute?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class SigClient {
  readonly reads: RateLimiter;
  /** Site endpoints (news) are unauthenticated and outside the API key budget; keep them gentle. */
  readonly site: RateLimiter;
  /** Order placement / cancellation budget (30 writes per minute per account, with safety). */
  readonly writes: RateLimiter;
  private apiKey: string;
  private base: string;
  private siteBase: string;
  private fetchFn: FetchFn;
  private timeoutMs: number;
  private sleep: (ms: number) => Promise<void>;
  private maxRetries: number;
  errors = 0;
  rateLimited = 0;
  closed = false;

  constructor(o: SigClientOptions = {}) {
    this.apiKey = o.apiKey ?? config.sigApiKey;
    this.base = (o.baseUrl ?? config.sigApiBase).replace(/\/$/, "");
    this.siteBase = (o.siteUrl ?? config.sigSiteBase).replace(/\/$/, "");
    this.fetchFn = o.fetchFn ?? ((...a) => fetch(...a));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.reads = new RateLimiter(Math.floor((o.readsPerMinute ?? config.readsPerMinute) * config.rateSafety), undefined, this.sleep);
    this.site = new RateLimiter(30, undefined, this.sleep);
    this.writes = new RateLimiter(Math.floor(config.writesPerMinute * 0.7), undefined, this.sleep);
    this.timeoutMs = o.timeoutMs ?? config.requestTimeoutMs;
    this.maxRetries = o.maxRetries ?? 3;
  }

  get hasKey() {
    return Boolean(this.apiKey);
  }

  close() {
    this.closed = true;
  }

  private async request<T>(
    url: string,
    opts: { auth: boolean; limiter: RateLimiter; timeoutMs?: number; maxRetries?: number; method?: string; body?: unknown },
  ): Promise<T> {
    if (opts.auth && !this.apiKey) throw new SigApiError(401, "MISSING_API_KEY", "SIG_API_KEY is not configured");
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    let attempt = 0;
    for (;;) {
      if (this.closed) throw new SigApiError(0, "CLIENT_CLOSED", "client closed");
      await opts.limiter.acquire();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const started = Date.now();
      try {
        const res = await this.fetchFn(url, {
          method: opts.method ?? "GET",
          headers: {
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(opts.auth ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (res.ok) return (await res.json()) as T;
        let body: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const code = body?.error?.code ?? `HTTP_${res.status}`;
        const msg = body?.error?.message ?? res.statusText;
        if (res.status === 429) {
          this.rateLimited++;
          const ra = Number(res.headers.get("retry-after") ?? "60");
          opts.limiter.pause((Number.isFinite(ra) ? ra : 60) * 1000);
          opts.limiter.throttle();
          log("WARNING", "sig_api", "rate_limited", { url: redact(url), retryAfterSec: ra });
          if (attempt++ < maxRetries) continue;
        }
        // Transient server conditions: exponential backoff with jitter.
        if ((res.status === 503 || res.status === 502 || res.status === 500) && attempt < maxRetries) {
          const backoff = 100 * 2 ** attempt + Math.random() * 100;
          attempt++;
          log("WARNING", "sig_api", "retry", { url: redact(url), status: res.status, code, backoffMs: Math.round(backoff) });
          await this.sleep(backoff);
          continue;
        }
        this.errors++;
        log("ERROR", "sig_api", "request_failed", { url: redact(url), status: res.status, code, ms: Date.now() - started });
        throw new SigApiError(res.status, code, msg, body?.error?.details);
      } catch (e) {
        if (e instanceof SigApiError) throw e;
        // Network error / timeout: reconnect by retrying with backoff.
        if (attempt < maxRetries) {
          const backoff = 250 * 2 ** attempt;
          attempt++;
          log("WARNING", "sig_api", "network_retry", { url: redact(url), error: String(e), backoffMs: backoff });
          await this.sleep(backoff);
          continue;
        }
        this.errors++;
        throw new SigApiError(0, "NETWORK_ERROR", String(e));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private api<T>(path: string, o: { timeoutMs?: number; maxRetries?: number } = {}) {
    return this.request<T>(`${this.base}${path}`, { auth: true, limiter: this.reads, ...o });
  }

  /** Writes retry with the SAME idempotency key (inside `body`), so a retry can never double-place. */
  private write<T>(path: string, method: string, body?: unknown) {
    return this.request<T>(`${this.base}${path}`, { auth: true, limiter: this.writes, method, body, timeoutMs: Math.max(this.timeoutMs, 60_000), maxRetries: 3 });
  }

  placeOrder(o: OrderInput & { idempotencyKey: string }) {
    return this.write<OrderResult>("/orders", "POST", o);
  }

  placeMultiLeg(legs: OrderInput[], idempotencyKey: string) {
    return this.write<{ results: { index: number; data: OrderResult }[] }>("/orders/multi-leg", "POST", { legs, idempotencyKey });
  }

  /** Cancel every open order of ours in one tournament, optionally one market (one write). */
  cancelAll(tournamentId: string, marketId?: string) {
    return this.write<{ cancelled: number }>("/orders/cancel-all", "POST", marketId ? { tournamentId, marketId } : { tournamentId });
  }

  async openOrders(tournamentId: string) {
    const r = await this.api<{ data: { id: number | string; exchangeId: string; side: string; action: string; quantity: number; priceLimit: number | null; open: boolean }[] }>(
      `/orders?status=open&limit=100&tournamentId=${encodeURIComponent(tournamentId)}`,
      { timeoutMs: Math.max(this.timeoutMs, 60_000), maxRetries: 2 },
    );
    return r.data ?? [];
  }

  getOrder(orderId: number | string) {
    return this.api<{ id: number; quantity: number; open: boolean }>(`/orders/${encodeURIComponent(String(orderId))}`, { timeoutMs: Math.max(this.timeoutMs, 60_000), maxRetries: 2 });
  }

  /** Short-lived (3 h) Realtime token; counts as one write. */
  realtimeToken() {
    return this.write<{ token: string; expiresAt: string; supabaseUrl: string; anonKey: string; channels: { user: string } }>("/realtime/token", "POST");
  }

  cancelOrder(orderId: number | string) {
    return this.write<{ orderId: number; message: string }>(`/orders/${encodeURIComponent(String(orderId))}`, "DELETE");
  }

  tournamentPositions(slug = config.tournamentSlug) {
    return this.api<{ positions: TournamentPosition[]; summary: { totalMarketValue: number; totalCostBasis: number } }>(
      `/tournaments/${encodeURIComponent(slug)}/portfolio/positions`,
      { timeoutMs: Math.max(this.timeoutMs, 60_000), maxRetries: 3 },
    );
  }

  tournamentPnl(slug = config.tournamentSlug) {
    return this.api<{ totalAccountValue: number; totalHoldingsValue: number; totalCostBasis: number; unrealizedPnl: number; roi: number | null }>(
      `/tournaments/${encodeURIComponent(slug)}/portfolio/pnl?period=all`,
      { timeoutMs: Math.max(this.timeoutMs, 60_000), maxRetries: 3 },
    );
  }

  account() {
    return this.api<{ id: string; username: string; balance: number }>("/account");
  }

  tournament(slug = config.tournamentSlug) {
    return this.api<Tournament>(`/tournaments/${encodeURIComponent(slug)}`);
  }

  async listMarkets(tournamentId?: string): Promise<RawMarket[]> {
    const out: RawMarket[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ limit: "100", status: "open" });
      if (tournamentId) q.set("tournamentId", tournamentId);
      if (cursor) q.set("cursor", cursor);
      const r = await this.api<{ data: RawMarket[]; pagination: { hasMore: boolean; nextCursor: string | null } }>(`/markets?${q}`, { timeoutMs: Math.max(this.timeoutMs, 60_000) });
      out.push(...r.data);
      if (!r.pagination?.hasMore || !r.pagination.nextCursor) break;
      cursor = r.pagination.nextCursor;
    }
    return out;
  }

  /** Bulk top-of-book for up to 100 exchanges per request. */
  async prices(exchangeIds: string[], tournamentId?: string): Promise<PriceSnapshot[]> {
    const out: PriceSnapshot[] = [];
    for (let i = 0; i < exchangeIds.length; i += 100) {
      const q = new URLSearchParams({ ids: exchangeIds.slice(i, i + 100).join(",") });
      if (tournamentId) q.set("tournamentId", tournamentId);
      // Fail fast: the collector continues on cached books, and the next tick retries.
      const r = await this.api<{ data: PriceSnapshot[] }>(`/exchanges/prices?${q}`, { timeoutMs: Math.min(this.timeoutMs, 20_000), maxRetries: 0 });
      out.push(...r.data);
    }
    return out;
  }

  /**
   * Depth for one market. Fails fast (short timeout, no retry): a slow depth read must never
   * stall the polling loop, the next tick simply refetches it.
   */
  async orderbook(marketId: string, tournamentId?: string, depth = 50): Promise<YesBook | null> {
    const q = new URLSearchParams({ depth: String(depth) });
    if (tournamentId) q.set("tournamentId", tournamentId);
    const r = await this.api<{
      exchanges: { exchangeId: string; asOf: { sequence: number; at: string } | null; bids: Level[]; asks: Level[] }[];
    }>(`/markets/${encodeURIComponent(marketId)}/orderbook?${q}`, { timeoutMs: Math.min(this.timeoutMs, 25_000), maxRetries: 0 });
    const ex = r.exchanges?.[0];
    if (!ex) return null;
    return normalizeBook({
      exchangeId: ex.exchangeId,
      marketId,
      bids: ex.bids,
      asks: ex.asks,
      asOf: ex.asOf ? `${ex.asOf.at}#${ex.asOf.sequence}` : new Date().toISOString(),
    });
  }

  trades(exchangeId: string, tournamentId?: string, limit = 100) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (tournamentId) q.set("tournamentId", tournamentId);
    return this.api<{ data: { id: string; price: number; quantity: number; createdAt?: string; side?: string }[] }>(
      `/exchanges/${encodeURIComponent(exchangeId)}/trades?${q}`,
    );
  }

  constraints(tournamentId?: string) {
    const q = new URLSearchParams({ violationsOnly: "true" });
    if (tournamentId) q.set("tournamentId", tournamentId);
    return this.api<{ data: unknown[]; violationsCount: number; computedAt: string }>(`/relationships/constraints?${q}`);
  }

  /**
   * Related-news feed shown on each SIG market page. Not part of the documented v1 API: it is
   * the site's own public endpoint, so its shape may change. Errors are non-fatal for callers.
   */
  /** epoch ms until which the site news endpoint is skipped (it returns 403 to some hosts) */
  newsBlockedUntil = 0;

  async news(marketId: string) {
    if (Date.now() < this.newsBlockedUntil) throw new SigApiError(403, "NEWS_BLOCKED", "news endpoint blocked; backing off");
    const id = encodeURIComponent(marketId);
    try {
      return await this.request<RawNews>(`${this.siteBase}/api/markets/${id}/news?marketId=${id}`, { auth: false, limiter: this.site, timeoutMs: 4000, maxRetries: 0 });
    } catch (e) {
      if (e instanceof SigApiError && e.status === 403) {
        // The site's bot protection blocks this host: stop hammering it for an hour.
        this.newsBlockedUntil = Date.now() + 60 * 60_000;
        log("WARNING", "sig_api", "news_blocked", { backoffMinutes: 60 });
      }
      throw e;
    }
  }
}

function redact(url: string) {
  return url.replace(/(key|token)=[^&]+/gi, "$1=***");
}

export function toSigMarket(m: RawMarket): SigMarket {
  const ex = m.exchanges[0];
  return {
    id: m.id,
    exchangeId: ex?.id ?? "",
    title: m.title,
    status: m.status,
    settlementDate: m.settlementDate,
    categories: m.categories ?? [],
    race: parseSigTitle(m.title, new Date(m.settlementDate).getUTCFullYear() || 2026),
    latestPrice: m.contexts?.[0]?.exchanges?.[0]?.latestPrice ?? ex?.latestPrice ?? null,
  };
}

/** Placeholder size for a touch whose price is known but size is not (never enough to trade on). */
export const UNKNOWN_QTY = 1;

/**
 * Merge a bulk top-of-book price into the last known book. Prices from the feed are always kept
 * (valuation and arbitrage hints need them); sizes are only trusted when the price is unchanged.
 * A new touch gets a 1-share placeholder (below any minimum order) until depth is fetched, and
 * deeper known levels behind the new touch are kept.
 */
export function bookFromPrice(p: PriceSnapshot, prev?: YesBook | null): YesBook {
  const sameTop = prev && (prev.bids[0]?.price ?? null) === p.bestBid && (prev.asks[0]?.price ?? null) === p.bestAsk;
  if (sameTop && prev) return prev;
  const side = (top: number | null, levels: Level[] | undefined, better: (a: number, b: number) => boolean): Level[] => {
    if (top === null) return [];
    const known = levels?.find((l) => Math.abs(l.price - top) < 1e-9);
    const behind = (levels ?? []).filter((l) => better(top, l.price) && Math.abs(l.price - top) > 1e-9);
    return [{ price: top, quantity: known?.quantity ?? UNKNOWN_QTY }, ...behind];
  };
  return normalizeBook({
    exchangeId: p.exchangeId,
    marketId: p.marketId,
    bids: side(p.bestBid, prev?.bids, (top, px) => px < top),
    asks: side(p.bestAsk, prev?.asks, (top, px) => px > top),
    asOf: `price:${p.bestBid}:${p.bestAsk}`,
    topOnly: true,
  });
}

let shared: SigClient | null = null;
export function sigClient(): SigClient {
  const g = globalThis as unknown as { __sigClient?: SigClient };
  if (!g.__sigClient) g.__sigClient = new SigClient();
  shared = g.__sigClient;
  return shared;
}
