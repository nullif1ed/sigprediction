import type { FairValueEstimate, FairValueInput } from "./types";
import { round } from "./orderbook";

export interface FairValueParams {
  /** weight of the SIG mid when its spread is 0 (decays as the spread widens) */
  sigWeight: number;
  /** weight per equivalent external venue at full liquidity */
  externalWeight: number;
  /** weight of 1 - complementary market mid */
  complementWeight: number;
  /** probability points added per unit of order-book imbalance */
  imbalanceCoef: number;
  /** max headline tilt in probability points */
  newsMaxTilt: number;
  /** spread at which SIG's own quote gets half its weight */
  spreadHalfWeight: number;
  /** minimum uncertainty (1 sd) in probability points */
  baseUncertainty: number;
}

export const DEFAULT_FAIR_VALUE: FairValueParams = {
  sigWeight: 1.0,
  externalWeight: 2.0,
  complementWeight: 0.6,
  imbalanceCoef: 0.005,
  newsMaxTilt: 0.03,
  spreadHalfWeight: 0.04,
  baseUncertainty: 0.02,
};

const clamp = (x: number, lo = 0.005, hi = 0.995) => Math.min(hi, Math.max(lo, x));

/**
 * Blend independent probability estimates into a fair value.
 * Probability (fairProbability) and confidence are deliberately separate outputs:
 * confidence reflects how much the sources agree and how informative they are.
 */
export function estimateFairValue(input: FairValueInput, p: FairValueParams = DEFAULT_FAIR_VALUE): FairValueEstimate | null {
  const comps: { source: string; value: number; weight: number }[] = [];
  const { bid, ask } = input.sigQuote;

  if (bid !== null && ask !== null) {
    const spread = Math.max(0, ask - bid);
    const w = p.sigWeight * (p.spreadHalfWeight / (p.spreadHalfWeight + spread));
    comps.push({ source: "sig_mid", value: (bid + ask) / 2, weight: w });
  } else if (bid !== null || ask !== null) {
    // One-sided book: the only quote is a bound, not an estimate. Give it a small weight.
    comps.push({ source: bid !== null ? "sig_bid_only" : "sig_ask_only", value: (bid ?? ask) as number, weight: 0.15 });
  }

  for (const x of input.external) {
    const v = x.mid ?? x.last;
    if (v === null || v === undefined) continue;
    const spread = x.bid !== null && x.ask !== null ? Math.max(0, x.ask - x.bid) : 0.1;
    const liq = x.volume ?? x.liquidity ?? 0;
    const liqFactor = Math.min(1, Math.log10(1 + liq) / 5); // ~1 at $100k volume
    const quality = x.matchQuality === "equivalent" ? 1 : 0.5;
    const tight = p.spreadHalfWeight / (p.spreadHalfWeight + spread);
    const w = p.externalWeight * quality * tight * Math.max(0.15, liqFactor);
    comps.push({ source: `${x.venue}:${x.externalId}`, value: v, weight: w });
  }

  if (input.complementMid !== null) {
    comps.push({ source: "complement", value: 1 - input.complementMid, weight: p.complementWeight });
  }

  if (!comps.length) return null;

  const W = comps.reduce((s, c) => s + c.weight, 0);
  let fair = comps.reduce((s, c) => s + c.value * c.weight, 0) / W;
  const variance = comps.reduce((s, c) => s + c.weight * (c.value - fair) ** 2, 0) / W;

  let newsShift = 0;
  if (input.headlines.length) {
    // Use non-decayed sentiment for fair value; decayed impact drives headline trades separately.
    const credW = input.headlines.reduce((s, h) => s + h.impact.credibility, 0);
    newsShift = credW
      ? (input.headlines.reduce((s, h) => s + h.impact.sentiment * h.impact.credibility, 0) / credW) * p.newsMaxTilt
      : 0;
    comps.push({ source: "news_tilt", value: newsShift, weight: 0 });
  }
  const imbShift = input.imbalance !== null ? input.imbalance * p.imbalanceCoef : 0;
  if (imbShift) comps.push({ source: "orderbook_imbalance", value: imbShift, weight: 0 });

  fair = clamp(fair + newsShift + imbShift);

  // Confidence comes from independent references (external venues, complement market), not from
  // SIG's own quote: disagreement between SIG and the references is the opportunity, not noise.
  const refs = comps.filter((c) => c.weight > 0 && !c.source.startsWith("sig_"));
  const refW = refs.reduce((s, c) => s + c.weight, 0);
  let refSd = 0.03; // assumed dispersion when fewer than two references exist
  if (refs.length >= 2) {
    const m = refs.reduce((s, c) => s + c.value * c.weight, 0) / refW;
    refSd = Math.sqrt(refs.reduce((s, c) => s + c.weight * (c.value - m) ** 2, 0) / refW);
  }
  // 1-sd uncertainty of the estimate: reference dispersion, or overall dispersion plus a penalty with no references.
  const sd = refs.length ? Math.sqrt(refSd ** 2 + p.baseUncertainty ** 2) : Math.sqrt(variance + p.baseUncertainty ** 2 + 0.03 ** 2);
  const agreement = 1 / (1 + (refSd / 0.03) ** 2);
  const breadth = 1 - Math.exp(-refW / 1.5);
  const sourceBonus = Math.min(1, refs.length / 2);
  const confidence = refs.length ? clamp(0.15 + 0.85 * agreement * breadth * (0.5 + 0.5 * sourceBonus), 0, 1) : 0.2;

  const used = comps.filter((c) => c.weight > 0).map((c) => `${c.source}=${c.value.toFixed(3)}`);
  const reasoning =
    `Blend of ${used.join(", ")}` +
    (newsShift ? `; news tilt ${(newsShift * 100).toFixed(1)}pp` : "") +
    (imbShift ? `; book imbalance ${(imbShift * 100).toFixed(2)}pp` : "") +
    `; reference dispersion ${(refSd * 100).toFixed(1)}pp`;

  return {
    marketId: input.marketId,
    fairProbability: round(fair, 4),
    confidence: round(confidence, 3),
    lowerBound: round(clamp(fair - 1.96 * sd), 4),
    upperBound: round(clamp(fair + 1.96 * sd), 4),
    components: comps.map((c) => ({ ...c, value: round(c.value, 4), weight: round(c.weight, 3) })),
    reasoning,
  };
}
