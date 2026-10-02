// Runtime configuration from environment variables. Never hardcode credentials.

function num(name: string, def: number): number {
  const v = process.env[name];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  sigApiKey: process.env.SIG_API_KEY ?? "",
  sigApiBase: process.env.SIG_API_BASE ?? "https://sig.thesuper.market/api/v1",
  sigSiteBase: process.env.SIG_SITE_BASE ?? "https://sig.thesuper.market",
  tournamentSlug: process.env.SIG_TOURNAMENT_SLUG ?? "midterm-elections",

  // Published per-key limits (API reference, "Rate limits & retries"): standard keys get
  // 100 reads per minute; 429 responses carry Retry-After: 60. Read-only, no writes/orders.
  readsPerMinute: num("SIG_READS_PER_MIN", 100),
  rateSafety: num("SIG_RATE_SAFETY", 0.85),
  requestTimeoutMs: num("SIG_TIMEOUT_MS", 30_000),

  /** fast loop: top of book for the "hot" markets (positions, arbitrage races, live signals) */
  priceIntervalSec: num("PRICE_POLL_SEC", 4),
  /** top of book for the whole universe (ceil(N/100) reads) */
  universeIntervalSec: num("UNIVERSE_POLL_SEC", 12),
  /** refetch depth of a hot market at least this often */
  hotDepthMaxAgeSec: num("HOT_DEPTH_MAX_AGE_SEC", 20),
  /** refetch depth of a market nothing is watching at most this often */
  coldDepthMaxAgeSec: num("COLD_DEPTH_MAX_AGE_SEC", 120),
  /** depth workers may use at most this share of the read budget; the rest stays free for price
   * polls and the dashboard, so the key is never run at its limit (which causes 429s/timeouts) */
  depthBudgetPct: Math.min(1, Math.max(0.1, num("DEPTH_BUDGET_PCT", 60) / 100)),
  /** parallel depth requests per tick */
  depthConcurrency: num("DEPTH_CONCURRENCY", 2),
  externalIntervalSec: num("EXTERNAL_POLL_SEC", 90),
  /** SIG website headline feed. Off by default: each call blocks the tick and the site often
   * times out or 403s. Set NEWS_MARKETS_PER_MIN=12 to turn it back on. */
  newsMarketsPerMinute: num("NEWS_MARKETS_PER_MIN", 0),
  marketsRefreshSec: num("MARKETS_REFRESH_SEC", 600),
  /** Trade only a sampled fraction of races (1 = all, 0.5 = half) to cut read/write load when
   * hitting SIG's rate limit. Sampling is by race, deterministic (hash of the race id), so a
   * race's legs are always kept or dropped together - never split across the cutoff. */
  marketSamplePct: Math.min(1, Math.max(0.01, num("MARKET_SAMPLE_PCT", 100) / 100)),
  snapshotHeartbeatSec: num("SNAPSHOT_HEARTBEAT_SEC", 60),

  initialBankroll: num("INITIAL_BANKROLL", 100_000),
  dbPath: process.env.DB_PATH ?? "./data/predictioncup.db",

  /** Optional shared secret for mutating endpoints (start/stop/reset). */
  adminToken: process.env.BOT_ADMIN_TOKEN ?? "",
  /** Order books from SIG Realtime (no REST reads); REST is only used to resync. */
  realtime: process.env.REALTIME !== "0",
  /** Read-only token for GET /api/export/db (database download for offline backtests). Empty disables it. */
  get exportToken() {
    return process.env.BOT_EXPORT_TOKEN ?? "";
  },
  /** Day-2: URL of the long-running bot backend that a Vercel UI proxies stateful calls to. */
  backendUrl: (process.env.BOT_BACKEND_URL ?? "").replace(/\/$/, ""),
  /** Reserved for future Polymarket CLOB features. Public price reads need no key. */
  polymarketApiKey: process.env.POLYMARKET_API_KEY ?? "",
  /** Reserved: Kalshi authenticated calls need this key ID plus an RSA private key. Market data is public. */
  kalshiApiKeyId: process.env.KALSHI_API_KEY_ID ?? "",
};

/**
 * Collection, paper trading and backtests need a long-running process and a writable disk.
 * Vercel functions have neither, so on Vercel these features are proxied to BOT_BACKEND_URL
 * (or reported unavailable). Set ENABLE_STATEFUL=1 to force them on.
 */
export function statefulMode(): "local" | "proxy" | "unavailable" {
  if (process.env.ENABLE_STATEFUL === "1") return "local";
  if (process.env.VERCEL) return config.backendUrl ? "proxy" : "unavailable";
  return "local";
}
