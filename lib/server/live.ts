import { sigClient, toSigMarket, type PriceSnapshot, type RawNews, type Tournament } from "./sigClient";
import { externalCached, discrepancy, type ExternalSnapshot } from "./external";
import { config } from "./config";
import type { ExternalQuote, NewsHeadline, Opportunity, SigMarket, YesBook } from "../core/types";
import { bookStats, normalizeBook } from "../core/orderbook";
import { computeSignals, DEFAULT_STRATEGY, type StrategyConfig } from "../core/engine";
import { evaluateMarket, rankOpportunities } from "../core/opportunity";
import { detectArbitrage } from "../core/arbitrage";
import { headlineId, headlineImpact } from "../core/news";
import { raceLabel } from "../core/races";

// Stateless live views (work on Vercel): every call is cached so page views cannot exhaust the
// 100 reads/minute API budget.

const memo = new Map<string, { at: number; v: unknown; p?: Promise<unknown> }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  if (hit?.p) return hit.p as Promise<T>;
  const p = fn()
    .then((v) => {
      memo.set(key, { at: Date.now(), v });
      return v;
    })
    .catch((e) => {
      if (hit) memo.set(key, { at: hit.at, v: hit.v });
      else memo.delete(key);
      throw e;
    });
  memo.set(key, { at: hit?.at ?? 0, v: hit?.v, p });
  return p;
}

export const getTournament = () => cached<Tournament>("tournament", 3_600_000, () => sigClient().tournament());

export async function getMarkets(): Promise<SigMarket[]> {
  return cached("markets", config.marketsRefreshSec * 1000, async () => {
    const t = await getTournament();
    return (await sigClient().listMarkets(t.id)).filter((m) => !m.isComposite && m.exchanges.length === 1).map(toSigMarket);
  });
}

export async function getPrices(markets: SigMarket[]): Promise<Map<string, PriceSnapshot>> {
  return cached("prices", 10_000, async () => {
    const t = await getTournament();
    const ps = await sigClient().prices(markets.map((m) => m.exchangeId), t.id);
    return new Map(ps.map((p) => [p.marketId, p]));
  });
}

export async function getDepth(marketId: string, ttlMs = 20_000): Promise<YesBook | null> {
  return cached(`depth:${marketId}`, ttlMs, async () => {
    const t = await getTournament();
    return sigClient().orderbook(marketId, t.id, 50);
  });
}

export async function getNews(marketId: string): Promise<RawNews | null> {
  return cached(`news:${marketId}`, 600_000, async () => {
    try {
      return await sigClient().news(marketId);
    } catch {
      return null;
    }
  });
}

export const getExternal = (markets: SigMarket[]): Promise<ExternalSnapshot> => externalCached(markets, config.externalIntervalSec * 1000);

/** Price-only book from a bulk snapshot. Quantity is unknown, so it is only used for screening. */
function screenBook(p: PriceSnapshot): YesBook {
  return normalizeBook({
    exchangeId: p.exchangeId,
    marketId: p.marketId,
    bids: p.bestBid !== null ? [{ price: p.bestBid, quantity: 1e9 }] : [],
    asks: p.bestAsk !== null ? [{ price: p.bestAsk, quantity: 1e9 }] : [],
    asOf: new Date().toISOString(),
    topOnly: true,
  });
}

export function actionPrices(bid: number | null, ask: number | null) {
  return {
    BUY_YES: ask,
    SELL_YES: bid,
    BUY_NO: bid !== null ? +(1 - bid).toFixed(4) : null,
    SELL_NO: ask !== null ? +(1 - ask).toFixed(4) : null,
  };
}

export interface MarketRow {
  id: string;
  title: string;
  race: string | null;
  party: string | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  actions: ReturnType<typeof actionPrices>;
  external: (ExternalQuote & { diff: number | null })[];
  maxDivergence: number | null;
}

export async function marketsTable(): Promise<{ rows: MarketRow[]; externalFetchedAt: string; matched: number; total: number }> {
  const markets = await getMarkets();
  const [prices, ext] = await Promise.all([getPrices(markets), getExternal(markets)]);
  const rows = markets.map((m) => {
    const p = prices.get(m.id);
    const bid = p?.bestBid ?? null;
    const ask = p?.bestAsk ?? null;
    const mid = bid !== null && ask !== null ? +((bid + ask) / 2).toFixed(4) : null;
    const external = (ext.byMarket.get(m.id) ?? []).map((q) => ({ ...q, diff: mid !== null && q.mid !== null ? +(mid - q.mid).toFixed(4) : null }));
    const divs = external.map((x) => x.diff).filter((x): x is number => x !== null);
    return {
      id: m.id,
      title: m.title,
      race: m.race ? raceLabel(m.race) : null,
      party: m.race?.party ?? null,
      bid,
      ask,
      mid,
      spread: bid !== null && ask !== null ? +(ask - bid).toFixed(4) : null,
      actions: actionPrices(bid, ask),
      external,
      maxDivergence: divs.length ? divs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : null,
    };
  });
  return { rows, externalFetchedAt: ext.fetchedAt, matched: ext.matched, total: markets.length };
}

function newsToHeadlines(marketId: string, raw: RawNews | null): NewsHeadline[] {
  return (raw?.headlines ?? []).map((h) => ({
    id: headlineId(h.url, h.title),
    marketId,
    url: h.url,
    title: h.title,
    source: h.source,
    summary: h.summary,
    publishedDate: h.publishedDate,
    relevanceExplanation: h.relevanceExplanation,
    // Stateless view cannot know when a headline first appeared; treat it as already priced in.
    firstSeenAt: h.publishedDate ? new Date(h.publishedDate).toISOString() : new Date(0).toISOString(),
  }));
}

/**
 * Live scan of the whole universe: screen every market on top-of-book, then fetch real depth for
 * the best candidates and re-evaluate with VWAP (never assume the touch size is unlimited).
 */
export async function scanOpportunities(cfg: StrategyConfig = DEFAULT_STRATEGY, depthCandidates = 8) {
  const markets = await getMarkets();
  const [prices, ext] = await Promise.all([getPrices(markets), getExternal(markets)]);
  const now = new Date();
  const screen = new Map<string, YesBook>();
  for (const m of markets) {
    const p = prices.get(m.id);
    if (p) screen.set(m.id, screenBook(p));
  }
  const state = { now, markets, books: screen, external: ext.byMarket, headlines: new Map<string, NewsHeadline[]>() };
  const sig = computeSignals(state, { ...cfg, headlineTrading: false });
  const screened: Opportunity[] = [];
  for (const m of markets) {
    const f = sig.fair.get(m.id);
    const b = screen.get(m.id);
    if (f && b) screened.push(...evaluateMarket({ marketId: m.id, title: m.title, book: b, fair: f, holdings: { YES: 0, NO: 0 }, params: cfg.eval }));
  }
  const candidates = [...new Set(rankOpportunities(screened, cfg.minNetEdge, cfg.minConfidence).map((o) => o.marketId))].slice(0, depthCandidates);
  const depth = new Map<string, YesBook>();
  await Promise.all(
    candidates.map(async (id) => {
      try {
        const b = await getDepth(id);
        if (b) depth.set(id, b);
      } catch {
        /* keep going on individual failures */
      }
    }),
  );
  const final: Opportunity[] = [];
  for (const id of candidates) {
    const m = markets.find((x) => x.id === id)!;
    const b = depth.get(id);
    const f = sig.fair.get(id);
    if (b && f) final.push(...evaluateMarket({ marketId: id, title: m.title, book: b, fair: f, holdings: { YES: 0, NO: 0 }, params: cfg.eval }));
  }
  const ranked = rankOpportunities(final, cfg.minNetEdge, cfg.minConfidence);
  const arbitrage = detectArbitrage(
    markets.filter((m) => m.race && screen.has(m.id)).map((m) => ({ marketId: m.id, race: m.race!, book: depth.get(m.id) ?? screen.get(m.id)! })),
  );
  return {
    asOf: now.toISOString(),
    opportunities: ranked,
    screenedCount: screened.length,
    depthChecked: candidates.length,
    arbitrage,
    fair: Object.fromEntries([...sig.fair.entries()].map(([k, v]) => [k, v])),
  };
}

export async function marketDetail(id: string, cfg: StrategyConfig = DEFAULT_STRATEGY) {
  const markets = await getMarkets();
  const m = markets.find((x) => x.id === id);
  if (!m) return null;
  const [book, news, ext, prices] = await Promise.all([getDepth(id, 10_000), getNews(id), getExternal(markets), getPrices(markets)]);
  const now = new Date();
  const heads = newsToHeadlines(id, news);
  const books = new Map<string, YesBook>();
  for (const x of markets) {
    const p = prices.get(x.id);
    if (p) books.set(x.id, screenBook(p));
  }
  if (book) books.set(id, book);
  const state = { now, markets, books, external: ext.byMarket, headlines: new Map([[id, heads]]) };
  const sig = computeSignals(state, { ...cfg, headlineTrading: false });
  const fair = sig.fair.get(id) ?? null;
  const opportunities = book && fair ? evaluateMarket({ marketId: id, title: m.title, book, fair, holdings: { YES: 0, NO: 0 }, params: cfg.eval }) : [];
  const stats = book ? bookStats(book) : null;
  const sigMid = stats?.mid ?? null;
  return {
    market: m,
    raceLabel: m.race ? raceLabel(m.race) : null,
    book,
    stats,
    actions: actionPrices(stats?.bestBid ?? null, stats?.bestAsk ?? null),
    fair,
    opportunities,
    external: (ext.byMarket.get(id) ?? []).map((q) => ({ ...q, discrepancy: discrepancy(sigMid, q) })),
    news: {
      contextSummary: news?.contextSummary ?? null,
      lastRefresh: news?.lastRefresh ?? null,
      headlines: heads.map((h) => ({ ...h, impact: headlineImpact(h, 0) })),
    },
  };
}
