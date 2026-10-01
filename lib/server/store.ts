import { db, j, pj, tx } from "./db";
import type { Decision, ExternalQuote, Fill, Level, NewsHeadline, PaperOrder, SigMarket, YesBook } from "../core/types";
import { headlineId } from "../core/news";
import type { RawNews } from "./sigClient";

export function upsertMarkets(markets: SigMarket[], ts = new Date().toISOString()) {
  const st = db().prepare(
    `INSERT INTO markets(id, exchange_id, title, status, settlement_date, categories, race, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET exchange_id=excluded.exchange_id, title=excluded.title, status=excluded.status,
       settlement_date=excluded.settlement_date, categories=excluded.categories, race=excluded.race, updated_at=excluded.updated_at`,
  );
  tx(() => {
    for (const m of markets) st.run(m.id, m.exchangeId, m.title, m.status, m.settlementDate, j(m.categories), j(m.race), ts);
  });
}

export function loadMarkets(): SigMarket[] {
  return db()
    .prepare("SELECT * FROM markets ORDER BY CAST(id AS INTEGER) DESC")
    .all()
    .map((r) => ({
      id: String(r.id),
      exchangeId: String(r.exchange_id),
      title: String(r.title),
      status: String(r.status),
      settlementDate: String(r.settlement_date),
      categories: pj<string[]>(r.categories, []),
      race: pj(r.race, null),
      latestPrice: null,
    }));
}

const lastStored = new Map<string, { sig: string; ts: number }>();
const bookSig = (b: YesBook) => j([b.bids, b.asks]);

/** Store a book when it changed or the heartbeat elapsed. Returns true when written. */
export function storeBook(ts: string, b: YesBook, heartbeatSec: number): boolean {
  const sig = bookSig(b);
  const prev = lastStored.get(b.marketId);
  const t = Date.parse(ts);
  if (prev && prev.sig === sig && t - prev.ts < heartbeatSec * 1000) return false;
  db()
    .prepare("INSERT INTO book_snapshots(ts, market_id, best_bid, best_ask, bids, asks, as_of, top_only) VALUES (?,?,?,?,?,?,?,?)")
    .run(ts, b.marketId, b.bids[0]?.price ?? null, b.asks[0]?.price ?? null, j(b.bids), j(b.asks), b.asOf, b.topOnly ? 1 : 0);
  lastStored.set(b.marketId, { sig, ts: t });
  return true;
}

export function resetStoreCache() {
  lastStored.clear();
}

export function latestBooks(): Map<string, YesBook> {
  const rows = db()
    .prepare("SELECT b.* FROM book_snapshots b JOIN (SELECT market_id, MAX(id) AS id FROM book_snapshots GROUP BY market_id) l ON b.id = l.id")
    .all();
  return new Map(rows.map((r) => [String(r.market_id), rowToBook(r)]));
}

export function rowToBook(r: Record<string, unknown>): YesBook {
  return {
    exchangeId: "",
    marketId: String(r.market_id),
    bids: pj<Level[]>(r.bids, []),
    asks: pj<Level[]>(r.asks, []),
    asOf: String(r.as_of ?? r.ts),
    topOnly: Number(r.top_only) === 1,
  };
}

export function storeExternal(ts: string, byMarket: Map<string, ExternalQuote[]>) {
  const st = db().prepare(
    "INSERT INTO external_quotes(ts, market_id, venue, external_id, bid, ask, mid, last, volume, liquidity, payload) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  tx(() => {
    for (const [mid, qs] of byMarket) for (const q of qs) st.run(ts, mid, q.venue, q.externalId, q.bid, q.ask, q.mid, q.last, q.volume, q.liquidity, j(q));
  });
}

/** SIG mid minus external mid history for a market/venue (for z-scores). */
export function discrepancyHistory(marketId: string, venue: string, limit = 500): number[] {
  const rows = db()
    .prepare(
      `SELECT e.mid AS emid, (SELECT (b.best_bid + b.best_ask) / 2 FROM book_snapshots b WHERE b.market_id = e.market_id AND b.ts <= e.ts
         AND b.best_bid IS NOT NULL AND b.best_ask IS NOT NULL ORDER BY b.ts DESC LIMIT 1) AS smid
       FROM external_quotes e WHERE e.market_id = ? AND e.venue = ? AND e.mid IS NOT NULL ORDER BY e.ts DESC LIMIT ?`,
    )
    .all(marketId, venue, limit);
  return rows.filter((r) => r.smid !== null).map((r) => Number(r.smid) - Number(r.emid));
}

/** Insert headlines; returns the ones never seen before (headline-trading triggers). */
export function storeNews(marketId: string, raw: RawNews, seenAt: string): NewsHeadline[] {
  const fresh: NewsHeadline[] = [];
  // First fetch for a market: existing headlines are not news to the market, so backdate them to
  // their publish date. Otherwise the bot would "headline trade" everything on its first poll.
  const firstFetch = !db().prepare("SELECT 1 FROM news_context WHERE market_id = ?").get(marketId);
  const ins = db().prepare(
    `INSERT OR IGNORE INTO headlines(id, market_id, url, title, source, summary, published_date, relevance, first_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  tx(() => {
    for (const h of raw.headlines ?? []) {
      const id = headlineId(h.url, h.title);
      const pub = Date.parse(h.publishedDate);
      const seen = firstFetch && Number.isFinite(pub) ? new Date(Math.min(pub, Date.parse(seenAt))).toISOString() : seenAt;
      const r = ins.run(id, marketId, h.url, h.title, h.source, h.summary, h.publishedDate, h.relevanceExplanation, seen);
      if (r.changes > 0)
        fresh.push({ id, marketId, url: h.url, title: h.title, source: h.source, summary: h.summary, publishedDate: h.publishedDate, relevanceExplanation: h.relevanceExplanation, firstSeenAt: seen });
    }
    db()
      .prepare(
        "INSERT INTO news_context(market_id, summary, last_refresh, fetched_at) VALUES (?,?,?,?) ON CONFLICT(market_id) DO UPDATE SET summary=excluded.summary, last_refresh=excluded.last_refresh, fetched_at=excluded.fetched_at",
      )
      .run(marketId, raw.contextSummary, raw.lastRefresh, seenAt);
  });
  return fresh;
}

const rowToHeadline = (r: Record<string, unknown>): NewsHeadline => ({
  id: String(r.id),
  marketId: String(r.market_id),
  url: String(r.url ?? ""),
  title: String(r.title ?? ""),
  source: String(r.source ?? ""),
  summary: String(r.summary ?? ""),
  publishedDate: String(r.published_date ?? ""),
  relevanceExplanation: String(r.relevance ?? ""),
  firstSeenAt: String(r.first_seen_at),
});

export function headlinesUpTo(ts: string): Map<string, NewsHeadline[]> {
  const out = new Map<string, NewsHeadline[]>();
  for (const r of db().prepare("SELECT * FROM headlines WHERE first_seen_at <= ? ORDER BY first_seen_at").all(ts)) {
    const h = rowToHeadline(r);
    out.set(h.marketId, [...(out.get(h.marketId) ?? []), h]);
  }
  return out;
}

export function recentHeadlines(limit = 50): NewsHeadline[] {
  return db().prepare("SELECT * FROM headlines ORDER BY first_seen_at DESC, published_date DESC LIMIT ?").all(limit).map(rowToHeadline);
}

export function dataRange(): { from: string | null; to: string | null; snapshots: number; markets: number } {
  const r = db().prepare("SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n, COUNT(DISTINCT market_id) m FROM book_snapshots").get() ?? {};
  return { from: (r.a as string) ?? null, to: (r.b as string) ?? null, snapshots: Number(r.n ?? 0), markets: Number(r.m ?? 0) };
}

export function logRow(ts: string, level: string, component: string, event: string, context: Record<string, unknown>) {
  db().prepare("INSERT INTO logs(ts, level, component, event, context) VALUES (?,?,?,?,?)").run(ts, level, component, event, j(context));
}

export function recentLogs(limit = 200, level?: string) {
  const rows = level
    ? db().prepare("SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?").all(level, limit)
    : db().prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({ ...r, context: pj(r.context, {}) }));
}

export function upsertOrder(o: PaperOrder) {
  db()
    .prepare(
      `INSERT INTO paper_orders(order_id, market_id, action, contract, order_type, limit_price, requested_quantity, filled_quantity,
         fill_price, fees, status, created_at, updated_at, notes, tag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(order_id) DO UPDATE SET filled_quantity=excluded.filled_quantity, fill_price=excluded.fill_price,
         fees=excluded.fees, status=excluded.status, updated_at=excluded.updated_at, notes=excluded.notes`,
    )
    .run(o.orderId, o.marketId, o.action, o.contract, o.orderType, o.limitPrice, o.requestedQuantity, o.filledQuantity, o.fillPrice, o.fees, o.status, o.createdAt, o.updatedAt, o.notes, o.tag ?? null);
}

export function insertFill(f: Fill) {
  db()
    .prepare("INSERT INTO paper_fills(order_id, market_id, action, quantity, price, yes_price, realized_pnl, ts) VALUES (?,?,?,?,?,?,?,?)")
    .run(f.orderId, f.marketId, f.action, f.quantity, f.price, f.yesPrice, f.realizedPnl, f.timestamp);
}

export function insertDecision(d: Decision) {
  db()
    .prepare("INSERT INTO decisions(ts, market_id, action, opportunity_type, quantity, net_edge, score, rejected, payload) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(d.timestamp, d.marketId, d.action, d.opportunityType, d.quantity, d.netEdge, d.riskAdjustedScore, d.rejected ?? null, j(d));
}
