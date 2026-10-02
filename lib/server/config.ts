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
  // 100 reads and 30 writes per minute; 429 responses carry Retry-After: 60.
  readsPerMinute: num("SIG_READS_PER_MIN", 100),
  writesPerMinute: num("SIG_WRITES_PER_MIN", 30),
  // The budget is per account and shared with the dashboard / Vercel UI / live trader.
  rateSafety: num("SIG_RATE_SAFETY", 0.85),
  requestTimeoutMs: num("SIG_TIMEOUT_MS", 30_000),

  /** fast loop: top of book for the "hot" markets (positions, arbitrage races, live signals) */
  priceIntervalSec: num("PRICE_POLL_SEC", 2),
  /** top of book for the whole universe (ceil(N/100) reads) */
  universeIntervalSec: num("UNIVERSE_POLL_SEC", 6),
  /** refetch depth of a hot market at least this often */
  hotDepthMaxAgeSec: num("HOT_DEPTH_MAX_AGE_SEC", 10),
  /** parallel depth requests per tick */
  depthConcurrency: num("DEPTH_CONCURRENCY", 4),
  externalIntervalSec: num("EXTERNAL_POLL_SEC", 90),
  newsMarketsPerMinute: num("NEWS_MARKETS_PER_MIN", 12),
  marketsRefreshSec: num("MARKETS_REFRESH_SEC", 600),
  snapshotHeartbeatSec: num("SNAPSHOT_HEARTBEAT_SEC", 60),

  initialBankroll: num("INITIAL_BANKROLL", 100_000),
  dbPath: process.env.DB_PATH ?? "./data/predictioncup.db",

  /** Optional shared secret for mutating endpoints (start/stop/reset). */
  adminToken: process.env.BOT_ADMIN_TOKEN ?? "",
  /** Order books from SIG Realtime (no REST reads); REST is only used to resync. */
  realtime: process.env.REALTIME !== "0",
  /** REAL orders on SIG. Off unless LIVE_TRADING=1. */
  get liveTrading() {
    return process.env.LIVE_TRADING === "1";
  },
  /** max notional (SUSQies) of one live order leg */
  liveMaxOrderNotional: num("LIVE_MAX_ORDER_NOTIONAL", 25_000),
  /** stop opening new live positions when account value falls this far below its start */
  liveMaxDrawdown: num("LIVE_MAX_DRAWDOWN", 0.05),
  /** live entries older than this when their turn to be sent comes are dropped (stale) */
  liveMaxOrderAgeSec: num("LIVE_MAX_ORDER_AGE_SEC", 20),
  liveReconcileSec: num("LIVE_RECONCILE_SEC", 30),
  /** One-time: sell every position at market when live trading starts (runs once per id; "" = off). */
  liquidateRunId: process.env.LIQUIDATE_RUN_ID ?? "liq-yolo-1",
  /** Market-making experiment (live only). Runs once per MM_RUN_ID; set MM_ENABLED=0 to skip. */
  mmEnabled: process.env.MM_ENABLED !== "0",
  mmRunId: process.env.MM_RUN_ID ?? "mm-exp-2",
  mmMarkets: num("MM_MARKETS", 3),
  mmSize: num("MM_SIZE", 500),
  mmMaxPos: num("MM_MAX_POS", 2000),
  mmMinSpread: num("MM_MIN_SPREAD", 0.02),
  mmMinEdge: num("MM_MIN_EDGE", 0.005),
  mmMinutes: num("MM_MINUTES", 60),
  mmRefreshSec: num("MM_REFRESH_SEC", 10),
  mmWritesReserve: num("MM_WRITES_RESERVE", 8),
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
