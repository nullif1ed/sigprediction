import type { Action, RaceKey, YesBook } from "./types";
import { raceId } from "./races";
import { round, simulateExecution } from "./orderbook";

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
  /** buy_all_yes only pays if one of the listed parties wins; third-party risk remains */
  conditional: boolean;
  note: string;
}

interface Member {
  marketId: string;
  race: RaceKey;
  book: YesBook;
}

function bestSet(members: Member[], action: Action, payoutFn: (n: number) => number, maxQty: number) {
  // Grow the set size while every additional share keeps a positive guaranteed profit.
  let best: { q: number; cost: number; legs: ArbLeg[] } | null = null;
  const step = 10;
  for (let q = step; q <= maxQty; q += step) {
    const legs: ArbLeg[] = [];
    let cost = 0;
    let ok = true;
    for (const m of members) {
      const ex = simulateExecution(m.book, action, q);
      if (ex.filled < q || ex.vwap === null) {
        ok = false;
        break;
      }
      legs.push({ marketId: m.marketId, action, price: ex.vwap, quantity: q });
      cost += ex.vwap;
    }
    if (!ok) break;
    if (payoutFn(members.length) - cost <= 1e-9) break;
    best = { q, cost, legs };
  }
  return best;
}

export function detectArbitrage(markets: Member[], opts: { minProfitPerSet?: number; maxQty?: number } = {}): ArbitrageOpportunity[] {
  const minProfit = opts.minProfitPerSet ?? 0.005;
  const maxQty = opts.maxQty ?? 5000;
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
        quantity: q,
        costPerSet: ask,
        guaranteedPayoutPerSet: bid,
        profitPerSet: round(bid - ask),
        totalProfit: round((bid - ask) * q, 2),
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
    const noSet = bestSet(members, "BUY_NO", (n) => n - 1, maxQty);
    if (noSet) {
      const payout = members.length - 1;
      const profit = payout - noSet.cost;
      if (profit >= minProfit)
        out.push({
          kind: "buy_all_no",
          raceId: rid,
          legs: noSet.legs,
          quantity: noSet.q,
          costPerSet: round(noSet.cost),
          guaranteedPayoutPerSet: payout,
          profitPerSet: round(profit),
          totalProfit: round(profit * noSet.q, 2),
          conditional: false,
          note: "YES bids across mutually exclusive outcomes sum above 1: buying NO on each locks in profit.",
        });
    }
    // Buy YES on every listed party: pays 1 only if one of them wins (third-party risk).
    const yesSet = bestSet(members, "BUY_YES", () => 1, maxQty);
    if (yesSet) {
      const profit = 1 - yesSet.cost;
      if (profit >= minProfit)
        out.push({
          kind: "buy_all_yes",
          raceId: rid,
          legs: yesSet.legs,
          quantity: yesSet.q,
          costPerSet: round(yesSet.cost),
          guaranteedPayoutPerSet: 1,
          profitPerSet: round(profit),
          totalProfit: round(profit * yesSet.q, 2),
          conditional: !parties.has("I"),
          note: "YES asks across outcomes sum below 1. Pays only if a listed party wins.",
        });
    }
  }
  return out.sort((a, b) => b.totalProfit - a.totalProfit);
}
