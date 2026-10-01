import type { HeadlineImpact, NewsHeadline } from "./types";

// SIG's news feed attaches a `relevanceExplanation` to every headline, written relative to the
// market question ("...raises the likelihood of a Democratic win"). We score that text plus the
// summary with a small, transparent lexicon. This is deliberately simple and auditable; the
// weights are tuning targets for Day 1 backtests.

const POSITIVE = [
  "raises the likelihood", "raises the probability", "increases the likelihood", "increases the probability",
  "improves", "boosts", "strengthens", "supports the view", "favored", "favours", "favors", "leading",
  "ahead", "lead", "momentum", "advantage", "edge", "likely to win", "more likely", "gains", "solid",
];
const NEGATIVE = [
  "lowers the likelihood", "lowers the probability", "reduces the likelihood", "reduces the probability",
  "lowers", "hurts", "weakens", "trailing", "behind", "underdog", "less likely", "narrow", "uphill",
  "long shot", "unlikely", "deficit", "damages", "drag", "weakened", "reducing", "negative development",
  "negative for", "setback", "slipping", "falling behind",
];
const NEGATION = /\b(not|no|never|isn't|aren't|doesn't|don't|without|fails to|yet to)\b[^.]{0,25}$/i;
const HEDGES = ["close", "competitive", "toss-up", "tossup", "uncertain", "remains sensitive", "still"];

const CREDIBILITY: [RegExp, number][] = [
  [/new york times|nyt|siena/i, 0.9],
  [/associated press|\bap\b|reuters/i, 0.9],
  [/cook political|sabato|inside elections|538|fivethirtyeight|silver bulletin/i, 0.85],
  [/unh|survey center|university|marist|quinnipiac|emerson|monmouth/i, 0.85],
  [/washington post|wall street journal|politico|axios|npr|bloomberg|cnn|nbc|abc|cbs/i, 0.8],
  [/the hill|rasmussen|newsweek|fox/i, 0.7],
  [/yahoo|msn|aol/i, 0.6],
];

export function sourceCredibility(source: string): number {
  for (const [re, c] of CREDIBILITY) if (re.test(source)) return c;
  return 0.55;
}

function countPhrases(text: string, phrases: string[]): number {
  return signedCount(text, phrases).plain + signedCount(text, phrases).negated;
}

/** Count phrase hits, separating those preceded by a negation ("not yet ahead"). */
function signedCount(text: string, phrases: string[]): { plain: number; negated: number } {
  let plain = 0;
  let negated = 0;
  for (const p of phrases) {
    const re = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    for (const m of text.matchAll(re)) {
      if (NEGATION.test(text.slice(Math.max(0, (m.index ?? 0) - 40), m.index))) negated++;
      else plain++;
    }
  }
  return { plain, negated };
}

/** Sentiment in [-1, 1] toward YES. */
export function headlineSentiment(h: Pick<NewsHeadline, "relevanceExplanation" | "summary" | "title">): number {
  // The relevance explanation is market-relative, so it carries most of the weight.
  const rel = h.relevanceExplanation ?? "";
  const other = `${h.title ?? ""} ${h.summary ?? ""}`;
  // Negative phrases containing positive words ("lowers the likelihood") are counted first and
  // removed so they are not double counted as positive.
  const strip = (t: string) => NEGATIVE.reduce((acc, p) => acc.replace(new RegExp(p, "gi"), " "), t);
  // A negated phrase counts toward the opposite direction ("not yet ahead" is negative).
  const score = (t: string) => {
    const neg = signedCount(t, NEGATIVE);
    const pos = signedCount(strip(t), POSITIVE);
    return pos.plain + neg.negated - (neg.plain + pos.negated);
  };
  const raw = 1.0 * score(rel) + 0.3 * score(other);
  const hedges = countPhrases(rel, HEDGES);
  const damp = 1 / (1 + 0.25 * hedges);
  return Math.max(-1, Math.min(1, Math.tanh(raw / 2) * damp));
}

export interface ImpactParams {
  maxShift: number; // cap on any single headline's probability shift
  halfLifeMinutes: number; // decay of the headline's tradable edge
}
export const DEFAULT_IMPACT: ImpactParams = { maxShift: 0.06, halfLifeMinutes: 90 };

export function headlineImpact(h: NewsHeadline, ageMinutes: number, p: ImpactParams = DEFAULT_IMPACT): HeadlineImpact {
  const sentiment = headlineSentiment(h);
  const credibility = sourceCredibility(h.source);
  const decay = Math.pow(0.5, Math.max(0, ageMinutes) / p.halfLifeMinutes);
  const shift = sentiment * credibility * p.maxShift * decay;
  const confidence = Math.min(1, Math.abs(sentiment) * credibility * (0.5 + 0.5 * decay));
  return {
    direction: Math.abs(shift) < 0.002 ? "neutral" : shift > 0 ? "bullish" : "bearish",
    shift,
    confidence,
    credibility,
    sentiment,
  };
}

/** Aggregate (non-decayed) news tilt used by the fair-value model, in probability points. */
export function newsTilt(headlines: NewsHeadline[], maxTilt = 0.03): number {
  if (!headlines.length) return 0;
  let num = 0;
  let den = 0;
  for (const h of headlines) {
    const c = sourceCredibility(h.source);
    num += headlineSentiment(h) * c;
    den += c;
  }
  return den ? (num / den) * maxTilt : 0;
}

export function headlineId(url: string, title: string): string {
  let h = 2166136261;
  const s = `${url}|${title}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
