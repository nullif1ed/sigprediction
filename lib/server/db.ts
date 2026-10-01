import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

// SQLite store using Node's built-in `node:sqlite` (no native dependency). Loaded lazily via
// process.getBuiltinModule so serverless bundles that never touch the store do not load it.

interface Stmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY, exchange_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT,
  settlement_date TEXT, categories TEXT, race TEXT, updated_at TEXT NOT NULL
);
-- Order-book snapshots. Stored on change plus a heartbeat; replay carries the last value forward.
CREATE TABLE IF NOT EXISTS book_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, market_id TEXT NOT NULL,
  best_bid REAL, best_ask REAL, bids TEXT NOT NULL, asks TEXT NOT NULL, as_of TEXT, top_only INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_book_ts ON book_snapshots(ts);
CREATE INDEX IF NOT EXISTS ix_book_market_ts ON book_snapshots(market_id, ts);
CREATE TABLE IF NOT EXISTS external_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, market_id TEXT NOT NULL, venue TEXT NOT NULL,
  external_id TEXT, bid REAL, ask REAL, mid REAL, last REAL, volume REAL, liquidity REAL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ext_market_ts ON external_quotes(market_id, ts);
CREATE INDEX IF NOT EXISTS ix_ext_ts ON external_quotes(ts);
CREATE TABLE IF NOT EXISTS headlines (
  id TEXT NOT NULL, market_id TEXT NOT NULL, url TEXT, title TEXT, source TEXT, summary TEXT,
  published_date TEXT, relevance TEXT, first_seen_at TEXT NOT NULL, PRIMARY KEY (id, market_id)
);
CREATE INDEX IF NOT EXISTS ix_head_seen ON headlines(first_seen_at);
CREATE TABLE IF NOT EXISTS news_context (
  market_id TEXT PRIMARY KEY, summary TEXT, last_refresh TEXT, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, stopped_at TEXT, status TEXT NOT NULL,
  ticks INTEGER NOT NULL DEFAULT 0, reads INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
  paper_trading INTEGER NOT NULL DEFAULT 0, note TEXT
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, level TEXT NOT NULL, component TEXT NOT NULL,
  event TEXT NOT NULL, context TEXT
);
CREATE INDEX IF NOT EXISTS ix_logs_ts ON logs(ts);
CREATE TABLE IF NOT EXISTS paper_orders (
  order_id TEXT PRIMARY KEY, market_id TEXT NOT NULL, action TEXT NOT NULL, contract TEXT NOT NULL,
  order_type TEXT NOT NULL, limit_price REAL, requested_quantity INTEGER NOT NULL, filled_quantity INTEGER NOT NULL,
  fill_price REAL, fees REAL NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  notes TEXT, tag TEXT
);
CREATE INDEX IF NOT EXISTS ix_orders_created ON paper_orders(created_at);
CREATE TABLE IF NOT EXISTS paper_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, market_id TEXT NOT NULL, action TEXT NOT NULL,
  quantity INTEGER NOT NULL, price REAL NOT NULL, yes_price REAL NOT NULL, realized_pnl REAL NOT NULL, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, market_id TEXT NOT NULL, action TEXT NOT NULL,
  opportunity_type TEXT NOT NULL, quantity INTEGER NOT NULL, net_edge REAL, score REAL, rejected TEXT, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_decisions_ts ON decisions(ts);
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backtest_sessions (
  session_id TEXT PRIMARY KEY, strategy_name TEXT NOT NULL, strategy_version TEXT NOT NULL, description TEXT,
  strategy_config TEXT NOT NULL, based_on TEXT, data_from TEXT, data_to TEXT, replay_speed REAL, latency_ms INTEGER,
  status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, sim_time TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  results TEXT, scenario_rules TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS backtest_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, portfolio TEXT NOT NULL, order_id TEXT,
  market_id TEXT NOT NULL, action TEXT NOT NULL, quantity INTEGER NOT NULL, price REAL NOT NULL,
  realized_pnl REAL NOT NULL, tag TEXT, sim_ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bt_trades ON backtest_trades(session_id, id);
CREATE TABLE IF NOT EXISTS backtest_equity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, portfolio TEXT NOT NULL, sim_ts TEXT NOT NULL,
  equity REAL NOT NULL, cash REAL NOT NULL, exposure REAL NOT NULL, drawdown REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bt_equity ON backtest_equity(session_id, portfolio, id);
CREATE TABLE IF NOT EXISTS backtest_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, sim_ts TEXT, level TEXT NOT NULL,
  message TEXT NOT NULL, context TEXT
);
CREATE INDEX IF NOT EXISTS ix_bt_logs ON backtest_logs(session_id, id);
`;

export function openDb(file = config.dbPath): Db {
  const sqlite = process.getBuiltinModule?.("node:sqlite") as { DatabaseSync: new (f: string) => Db } | undefined;
  if (!sqlite) throw new Error("node:sqlite is unavailable; use Node.js 22.13+.");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function db(): Db {
  const g = globalThis as unknown as { __pcDb?: Db };
  if (!g.__pcDb) g.__pcDb = openDb();
  return g.__pcDb;
}

/** Test hook: swap the global database (e.g. for an in-memory one). */
export function setDb(d: Db | null) {
  (globalThis as unknown as { __pcDb?: Db | null }).__pcDb = d;
}

export const j = (v: unknown) => JSON.stringify(v);
export const pj = <T>(v: unknown, def: T): T => {
  if (typeof v !== "string") return def;
  try {
    return JSON.parse(v) as T;
  } catch {
    return def;
  }
};

export function kvGet<T>(k: string, def: T): T {
  const r = db().prepare("SELECT v FROM kv WHERE k = ?").get(k);
  return r ? pj<T>(r.v, def) : def;
}

export function kvSet(k: string, v: unknown) {
  db()
    .prepare("INSERT INTO kv(k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
    .run(k, j(v), new Date().toISOString());
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
