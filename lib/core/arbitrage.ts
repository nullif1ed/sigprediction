import type { Action, RaceKey, YesBook } from "./types";
import { raceId } from "./races";
import { contractLevels, round } from "./orderbook";

// On SIG every market is one YES exchange and the NO book is derived from it, so a single market
// can never show YES ask + NO ask < 1 (that sum is always 1 + spread). Real mispricing shows up:
//  1. across mutually exclusive markets in the same race (Dem vs Rep vs Ind for one seat), and
//  2. as a crossed book (bid >= ask) on one exchange, which should be transient.
// The engine's own `/relationships/constraints` endpoint is consulted separately.

export interface ArbLeg {
  marketId: string;
  action: Action;
  price: number; // contract-terms VWAP
  quantity: number;
}

export interface ArbitrageOpportunity {
  kind: "buy_all_no" | "buy_all_yes" | "crossed_book";
  raceId: string;
  legs: ArbLeg[];
  quantity: number; // per leg
  costPerSet: number;
  guaranteedPayoutPerSet: number;
  profitPerSet: number;
  totalProfit: number;
  /** profit per set / cost per set (capital is locked until settlement) */
  returnOnCapital: number;
  /** profitable depth ladder; the allocator spends capital tranche by tranche */
  tranches: Tranche[];
  /** buy_all_yes only pays if one of the listed parties wins; third-party risk remains */
  conditional: boolean;
  note: string;
}

interface Member {
  marketId: string;
  race: RaceKey;
  book: YesBook;
}

export interface Tranche {
  quantity: number; // sets available at this price step
  costPerSet: number; // marginal cost of one set at this step (sum of leg level prices)
}

export interface SetSize {
  q: number;
  cost: number; // total cost of q sets
  legs: ArbLeg[];
  /** depth ladder of profitable sets, best (cheapest) first */
  tranches: Tranche[];
}

/**
 * Largest profitable set size: walks every leg's book level by level and adds sets only while the
 * MARGINAL set (sum of the current level prices) still pays out more than it costs by at least
 * `minMarginal`. Stopping on marginal rather than average cost maximises total profit: deeper
 * levels that would lose money on their own are never bought. `maxQty` caps the walk.
 */
export function sizeSet(
  legs: { marketId: string; action: Action; book: YesBook }[],
  payout: number,
  maxQty = Number.MAX_SAFE_INTEGER,
  minMarginal = 0.001,
): SetSize | null {
  const ladders = legs.map((l) => contractLevels(l.book, l.action).map((x) => ({ ...x })));
  if (!ladders.length || ladders.some((x) => !x.length)) return null;
  const idx = ladders.map(() => 0);
  const notional = ladders.map(() => 0);
  const tranches: Tranche[] = [];
  let q = 0;
  for (;;) {
    if (idx.some((i, k) => i >= ladders[k].length)) break;
    const marginal = ladders.reduce((s, lv, k) => s + lv[idx[k]].price, 0);
    if (payout - marginal < minMarginal - 1e-12) break;
    const chunk = Math.min(maxQty - q, ...ladders.map((lv, k) => lv[idx[k]].quantity));
    if (chunk <= 0) break;
    for (let k = 0; k < ladders.length; k++) {
      const lv = ladders[k][idx[k]];
      notional[k] += chunk * lv.price;
      lv.quantity -= chunk;
      if (lv.quantity <= 0) idx[k]++;
    }
    q += chunk;
    tranches.push({ quantity: chunk, costPerSet: round(marginal) });
    if (q >= maxQty) break;
  }
  if (q <= 0) return null;
  return {
    tranches,
    q,
    cost: notional.reduce((a, b) => a + b, 0),
    legs: legs.map((l, k) => ({ marketId: l.marketId, action: l.action, price: round(notional[k] / q), quantity: q })),
  };
}

export function detectArbitrage(markets: Member[], opts: { minProfitPerSet?: number; maxQty?: number } = {}): ArbitrageOpportunity[] {
  const minProfit = opts.minProfitPerSet ?? 0.005;
  const maxQty = opts.maxQty ?? Number.MAX_SAFE_INTEGER;
  const out: ArbitrageOpportunity[] = [];

  for (const m of markets) {
    const bid = m.book.bids[0]?.price;
    const ask = m.book.asks[0]?.price;
    if (bid !== undefined && ask !== undefined && bid > ask + 1e-9) {
      const q = Math.min(m.book.bids[0].quantity, m.book.asks[0].quantity);
      out.push({
        kind: "crossed_book",
        raceId: raceId(m.race),
        legs: [
          { marketId: m.marketId, action: "BUY_YES", price: ask, quantity: q },
          { marketId: m.marketId, action: "SELL_YES", price: bid, quantity: q },
        ],
        tranches: [{ quantity: q, costPerSet: ask }],
        quantity: q,
        costPerSet: ask,
        guaranteedPayoutPerSet: bid,
        profitPerSet: round(bid - ask),
        totalProfit: round((bid - ask) * q, 2),
        returnOnCapital: round((bid - ask) / ask, 5),
        conditional: false,
        note: "Crossed book on a single exchange (bid above ask).",
      });
    }
  }

  const groups = new Map<string, Member[]>();
  for (const m of markets) {
    const k = raceId(m.race);
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  for (const [rid, members] of groups) {
    const parties = new Set(members.map((m) => m.race.party));
    if (members.length < 2 || parties.size !== members.length) continue;

    // Buy NO on every listed party: at most one of them wins, so n-1 NO shares always pay out.
    const payoutNo = members.length - 1;
    const noSet = sizeSet(members.map((m) => ({ marketId: m.marketId, action: "BUY_NO" as Action, book: m.book })), payoutNo, maxQty);
    if (noSet) {
      const cps = noSet.cost / noSet.q;
      const profit = payoutNo - cps;
      if (profit >= minProfit)
        out.push({
          kind: "buy_all_no",
          raceId: rid,
          legs: noSet.legs,
          tranches: noSet.tranches,
          quantity: noSet.q,
          costPerSet: round(cps),
          guaranteedPayoutPerSet: payoutNo,
          profitPerSet: round(profit),
          totalProfit: round(profit * noSet.q, 2),
          returnOnCapital: round(profit / cps, 5),
          conditional: false,
          note: "YES bids across mutually exclusive outcomes sum above 1: buying NO on each locks in profit.",
        });
    }
    // Buy YES on every listed party: pays 1 only if one of them wins (third-party risk).
    const yesSet = sizeSet(members.map((m) => ({ marketId: m.marketId, action: "BUY_YES" as Action, book: m.book })), 1, maxQty);
    if (yesSet) {
      const cps = yesSet.cost / yesSet.q;
      const profit = 1 - cps;
      if (profit >= minProfit)
        out.push({
          kind: "buy_all_yes",
          raceId: rid,
          legs: yesSet.legs,
          tranches: yesSet.tranches,
          quantity: yesSet.q,
          costPerSet: round(cps),
          guaranteedPayoutPerSet: 1,
          profitPerSet: round(profit),
          totalProfit: round(profit * yesSet.q, 2),
          returnOnCapital: round(profit / cps, 5),
          conditional: !parties.has("I"),
          note: "YES asks across outcomes sum below 1. Pays only if a listed party wins.",
        });
    }
  }
  // Capital is the binding constraint, so rank by return on capital, then absolute profit.
  return out.sort((a, b) => b.returnOnCapital - a.returnOnCapital || b.totalProfit - a.totalProfit);
}
