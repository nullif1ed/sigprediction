import { config } from "./config";
import { log } from "./log";
import { RateLimiter } from "./rateLimiter";
import type { Level, SigMarket, YesBook } from "../core/types";
import { normalizeBook } from "../core/orderbook";
import { parseSigTitle } from "../core/races";

// Read-only client for the Super Market API (https://sig.thesuper.market/api/v1/docs).
// There are intentionally no order-placement methods: execution in this project is paper only.

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
    this.timeoutMs = o.timeoutMs ?? config.requestTimeoutMs;
    this.maxRetries = o.maxRetries ?? 3;
  }

  get hasKey() {
    return Boolean(this.apiKey);
  }

  close() {
    this.closed = true;
  }

  private async request<T>(url: string, opts: { auth: boolean; limiter: RateLimiter }): Promise<T> {
    if (opts.auth && !this.apiKey) throw new SigApiError(401, "MISSING_API_KEY", "SIG_API_KEY is not configured");
    let attempt = 0;
    for (;;) {
      if (this.closed) throw new SigApiError(0, "CLIENT_CLOSED", "client closed");
      await opts.limiter.acquire();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const started = Date.now();
      try {
        const res = await this.fetchFn(url, {
          headers: { Accept: "application/json", ...(opts.auth ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
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
          log("WARNING", "sig_api", "rate_limited", { url: redact(url), retryAfterSec: ra });
          if (attempt++ < this.maxRetries) continue;
        }
        // Transient server conditions: exponential backoff with jitter.
        if ((res.status === 503 || res.status === 502 || res.status === 500) && attempt < this.maxRetries) {
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
        if (attempt < this.maxRetries) {
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

  private api<T>(path: string) {
    return this.request<T>(`${this.base}${path}`, { auth: true, limiter: this.reads });
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
      const r = await this.api<{ data: RawMarket[]; pagination: { hasMore: boolean; nextCursor: string | null } }>(`/markets?${q}`);
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
      const r = await this.api<{ data: PriceSnapshot[] }>(`/exchanges/prices?${q}`);
      out.push(...r.data);
    }
    return out;
  }

  async orderbook(marketId: string, tournamentId?: string, depth = 50): Promise<YesBook | null> {
    const q = new URLSearchParams({ depth: String(depth) });
    if (tournamentId) q.set("tournamentId", tournamentId);
    const r = await this.api<{
      exchanges: { exchangeId: string; asOf: { sequence: number; at: string } | null; bids: Level[]; asks: Level[] }[];
    }>(`/markets/${encodeURIComponent(marketId)}/orderbook?${q}`);
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
  news(marketId: string) {
    const id = encodeURIComponent(marketId);
    return this.request<RawNews>(`${this.siteBase}/api/markets/${id}/news?marketId=${id}`, { auth: false, limiter: this.site });
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

/** Top-of-book only book from a bulk price snapshot (quantities unknown). */
export function bookFromPrice(p: PriceSnapshot, prev?: YesBook | null): YesBook {
  const qtyAt = (side: Level[] | undefined, price: number | null) => {
    const hit = side?.find((l) => Math.abs(l.price - (price ?? -1)) < 1e-9);
    return hit?.quantity ?? 0;
  };
  // If the touch moved we do not know the size behind it; keep known size when price unchanged.
  const bids = p.bestBid !== null ? [{ price: p.bestBid, quantity: qtyAt(prev?.bids, p.bestBid) }] : [];
  const asks = p.bestAsk !== null ? [{ price: p.bestAsk, quantity: qtyAt(prev?.asks, p.bestAsk) }] : [];
  const sameTop = prev && prev.bids[0]?.price === (p.bestBid ?? undefined) && prev.asks[0]?.price === (p.bestAsk ?? undefined);
  if (sameTop && prev) return prev;
  return normalizeBook({
    exchangeId: p.exchangeId,
    marketId: p.marketId,
    bids: bids.filter((l) => l.quantity > 0),
    asks: asks.filter((l) => l.quantity > 0),
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
