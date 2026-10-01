import type { ExternalQuote, RaceKey, SigMarket } from "../core/types";
import { isWinnerEventFor, kalshiEventTickers, partyFromText, polymarketSearchQuery, polymarketSlugs, raceId, raceLabel } from "../core/races";
import { log } from "./log";

// Reference prices from Polymarket (Gamma API) and Kalshi (public trade API). Both are public
// read endpoints, so no credentials are required. Neither venue is assumed to be "correct";
// quotes are inputs to the fair-value blend and to discrepancy monitoring.

const GAMMA = "https://gamma-api.polymarket.com";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

type FetchFn = typeof fetch;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const mid = (bid: number | null, ask: number | null, last: number | null): number | null => {
  // Ignore placeholder quotes (0 bid / 1 ask) that mean "no market".
  if (bid !== null && ask !== null && bid > 0 && ask < 1 && ask >= bid) return (bid + ask) / 2;
  return last !== null && last > 0 && last < 1 ? last : null;
};

interface GammaMarket {
  question: string;
  groupItemTitle?: string;
  slug: string;
  outcomes?: string;
  outcomePrices?: string;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  volumeNum?: number;
  liquidityNum?: number;
  closed?: boolean;
  active?: boolean;
  endDate?: string;
}
interface GammaEvent {
  slug: string;
  title: string;
  endDate?: string;
  closed?: boolean;
  markets: GammaMarket[];
}

interface KalshiMarket {
  ticker: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  liquidity_dollars?: string;
  rules_primary?: string;
}

function criteria(r: RaceKey, venue: string): { quality: "equivalent" | "near"; note: string } {
  if (r.office === "HOUSE_CONTROL" || r.office === "SENATE_CONTROL")
    return { quality: "near", note: `${venue} resolves on chamber control after the ${r.cycle} midterms; SIG asks which party "wins" it.` };
  if (r.party === "I") return { quality: "near", note: `${venue} lists a named independent candidate; SIG asks about the "Independent Party".` };
  return { quality: "equivalent", note: `Same ${r.cycle} race and party.` };
}

/** Pick the external market for a party from a list of (label, quote) candidates. */
function pickParty<T>(r: RaceKey, items: { text: string; suffix?: string; item: T }[]): T | null {
  if (r.party === "I") {
    const ind = items.filter((x) => (x.suffix ? !["D", "R"].includes(x.suffix) : partyFromText(x.text) === "I"));
    return ind.length === 1 ? ind[0].item : null;
  }
  const hit = items.filter((x) => (x.suffix ? x.suffix === r.party : partyFromText(x.text) === r.party));
  return hit.length === 1 ? hit[0].item : null;
}

/** Race -> discovered Polymarket event slug (from search), cached across refreshes. */
const discovered = new Map<string, string | null>();

export async function fetchPolymarket(races: RaceKey[], fetchFn: FetchFn = fetch): Promise<Map<string, GammaEvent>> {
  const known = (r: RaceKey) => [...polymarketSlugs(r), ...(discovered.get(raceId(r)) ? [discovered.get(raceId(r))!] : [])];
  const slugs = [...new Set(races.flatMap(known))];
  const out = new Map<string, GammaEvent>();
  for (let i = 0; i < slugs.length; i += 40) {
    const q = slugs.slice(i, i + 40).map((s) => `slug=${encodeURIComponent(s)}`).join("&");
    try {
      const d = (await getJson(`${GAMMA}/events?${q}&limit=100`, fetchFn)) as GammaEvent[] | null;
      for (const e of d ?? []) out.set(e.slug, e);
    } catch (e) {
      log("WARNING", "external", "polymarket_error", { error: String(e) });
    }
  }
  // Slugs are not uniform across races; search once for races still without an event.
  for (const r of races) {
    const id = raceId(r);
    if (discovered.has(id) || known(r).some((s) => out.has(s))) continue;
    const q = polymarketSearchQuery(r);
    if (!q) {
      discovered.set(id, null);
      continue;
    }
    try {
      const d = (await getJson(`${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=10`, fetchFn)) as { events?: GammaEvent[] } | null;
      const hit = (d?.events ?? []).find(
        (e) => !e.closed && (!e.endDate || new Date(e.endDate).getUTCFullYear() === r.cycle) && isWinnerEventFor(r, e.title) && e.markets?.length,
      );
      discovered.set(id, hit?.slug ?? null);
      if (hit) out.set(hit.slug, hit);
    } catch (e) {
      log("WARNING", "external", "polymarket_search_error", { race: id, error: String(e) });
    }
  }
  return out;
}

export function polymarketQuote(r: RaceKey, events: Map<string, GammaEvent>, now = new Date()): ExternalQuote | null {
  const extra = discovered.get(raceId(r));
  for (const slug of [...polymarketSlugs(r), ...(extra ? [extra] : [])]) {
    const e = events.get(slug);
    if (!e || e.closed) continue;
    // Cycle check: the event must end in the race's election year.
    if (e.endDate && new Date(e.endDate).getUTCFullYear() !== r.cycle) continue;
    const live = e.markets.filter((m) => !m.closed && m.active !== false);
    const m = pickParty(r, live.map((x) => ({ text: `${x.question} ${x.groupItemTitle ?? ""}`, item: x })));
    if (!m) continue;
    const bid = num(m.bestBid);
    const ask = num(m.bestAsk);
    const last = num(m.lastTradePrice);
    const c = criteria(r, "Polymarket");
    return {
      venue: "polymarket",
      externalId: m.slug,
      question: m.question,
      bid,
      ask,
      last,
      mid: mid(bid, ask, last),
      volume: num(m.volumeNum),
      liquidity: num(m.liquidityNum),
      url: `https://polymarket.com/event/${e.slug}`,
      matchQuality: c.quality,
      criteriaNote: c.note,
      fetchedAt: now.toISOString(),
    };
  }
  return null;
}

async function getJson(url: string, fetchFn: FetchFn, retries = 2): Promise<unknown | null> {
  for (let i = 0; ; i++) {
    const res = await fetchFn(url, { cache: "no-store" });
    if (res.status === 404) return null;
    if (res.status === 429 && i < retries) {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    return res.json();
  }
}

/**
 * Kalshi quotes. D/R markets have predictable tickers (`SENATENH-26-D`), so they are fetched in
 * batches via `/markets?tickers=`; independents need the event's market list. Keeps the request
 * count small enough for Kalshi's public rate limit.
 */
export async function fetchKalshi(races: RaceKey[], fetchFn: FetchFn = fetch): Promise<Map<string, KalshiMarket[]>> {
  const out = new Map<string, KalshiMarket[]>();
  const partyTickers = [...new Set(races.filter((r) => r.party !== "I").flatMap((r) => kalshiEventTickers(r).map((e) => `${e}-${r.party}`)))];
  for (let i = 0; i < partyTickers.length; i += 50) {
    const batch = partyTickers.slice(i, i + 50);
    try {
      const d = (await getJson(`${KALSHI}/markets?tickers=${batch.map(encodeURIComponent).join(",")}&limit=100`, fetchFn)) as { markets?: KalshiMarket[] } | null;
      for (const m of d?.markets ?? []) {
        const ev = m.ticker.slice(0, m.ticker.lastIndexOf("-"));
        out.set(ev, [...(out.get(ev) ?? []), m]);
      }
    } catch (e) {
      log("WARNING", "external", "kalshi_error", { batch: batch.length, error: String(e) });
    }
  }
  const indEvents = [...new Set(races.filter((r) => r.party === "I").flatMap(kalshiEventTickers))];
  for (const t of indEvents) {
    try {
      const d = (await getJson(`${KALSHI}/events/${encodeURIComponent(t)}?with_nested_markets=true`, fetchFn)) as { event?: { markets?: KalshiMarket[] }; markets?: KalshiMarket[] } | null;
      if (!d) continue;
      const ms = d.markets?.length ? d.markets : (d.event?.markets ?? []);
      const known = new Set((out.get(t) ?? []).map((m) => m.ticker));
      out.set(t, [...(out.get(t) ?? []), ...ms.filter((m) => !known.has(m.ticker))]);
    } catch (e) {
      log("WARNING", "external", "kalshi_error", { ticker: t, error: String(e) });
    }
  }
  return out;
}

export function kalshiQuote(r: RaceKey, events: Map<string, KalshiMarket[]>, now = new Date()): ExternalQuote | null {
  for (const t of kalshiEventTickers(r)) {
    const ms = (events.get(t) ?? []).filter((m) => !m.status || ["active", "open", "initialized"].includes(m.status));
    const m = pickParty(r, ms.map((x) => ({ text: x.yes_sub_title ?? "", suffix: x.ticker.split("-").pop(), item: x })));
    if (!m) continue;
    const bid = num(m.yes_bid_dollars);
    const ask = num(m.yes_ask_dollars);
    const last = num(m.last_price_dollars);
    const c = criteria(r, "Kalshi");
    return {
      venue: "kalshi",
      externalId: m.ticker,
      question: `${raceLabel(r)}: ${m.yes_sub_title ?? m.ticker}`,
      bid,
      ask,
      last,
      mid: mid(bid, ask, last),
      volume: num(m.volume_fp),
      liquidity: num(m.liquidity_dollars),
      url: `https://kalshi.com/markets/${t.split("-")[0].toLowerCase()}`,
      matchQuality: c.quality,
      criteriaNote: c.note + (m.yes_sub_title ? ` Kalshi outcome: ${m.yes_sub_title}.` : ""),
      fetchedAt: now.toISOString(),
    };
  }
  return null;
}

export interface ExternalSnapshot {
  fetchedAt: string;
  byMarket: Map<string, ExternalQuote[]>;
  matched: number;
  unmatched: string[];
}

export async function fetchExternal(markets: SigMarket[], fetchFn: FetchFn = fetch): Promise<ExternalSnapshot> {
  const races = markets.map((m) => m.race).filter((r): r is RaceKey => Boolean(r));
  const unique = [...new Map(races.map((r) => [raceId(r), r])).values()];
  const [poly, kal] = await Promise.all([fetchPolymarket(unique, fetchFn), fetchKalshi(unique, fetchFn)]);
  const now = new Date();
  const byMarket = new Map<string, ExternalQuote[]>();
  const unmatched: string[] = [];
  for (const m of markets) {
    if (!m.race) {
      unmatched.push(m.id);
      continue;
    }
    const qs = [polymarketQuote(m.race, poly, now), kalshiQuote(m.race, kal, now)].filter((q): q is ExternalQuote => q !== null);
    if (qs.length) byMarket.set(m.id, qs);
    else unmatched.push(m.id);
  }
  return { fetchedAt: now.toISOString(), byMarket, matched: byMarket.size, unmatched };
}

let cache: { at: number; key: string; snap: ExternalSnapshot; pending?: Promise<ExternalSnapshot> } | null = null;

/** Cached external snapshot (shared by API routes and the collector). */
export async function externalCached(markets: SigMarket[], maxAgeMs = 90_000): Promise<ExternalSnapshot> {
  const key = markets.map((m) => m.id).join(",");
  if (cache && cache.key === key && Date.now() - cache.at < maxAgeMs) return cache.snap;
  if (cache?.pending && cache.key === key) return cache.pending;
  const pending = fetchExternal(markets).then((snap) => {
    cache = { at: Date.now(), key, snap };
    return snap;
  });
  cache = cache ? { ...cache, key, pending } : { at: 0, key, snap: { fetchedAt: "", byMarket: new Map(), matched: 0, unmatched: [] }, pending };
  return pending;
}

/** Discrepancy statistics for one SIG market vs one external venue. */
export function discrepancy(sigMid: number | null, ext: ExternalQuote, history: number[] = []) {
  if (sigMid === null || ext.mid === null) return null;
  const diff = sigMid - ext.mid;
  const n = history.length;
  const m = n ? history.reduce((s, v) => s + v, 0) / n : null;
  const sd = n > 1 && m !== null ? Math.sqrt(history.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1)) : null;
  const extSpread = ext.bid !== null && ext.ask !== null ? ext.ask - ext.bid : null;
  // Liquidity-adjusted: shrink the gap by the external venue's own half-spread.
  const adj = extSpread !== null ? Math.sign(diff) * Math.max(0, Math.abs(diff) - extSpread / 2) : diff;
  return {
    priceDiff: +diff.toFixed(4),
    impliedProbDiffPct: +(diff * 100).toFixed(2),
    historicalMeanDiff: m === null ? null : +m.toFixed(4),
    historicalSdDiff: sd === null ? null : +sd.toFixed(4),
    zScore: sd && m !== null ? +((diff - m) / sd).toFixed(2) : null,
    liquidityAdjustedDiff: +adj.toFixed(4),
    samples: n,
  };
}
