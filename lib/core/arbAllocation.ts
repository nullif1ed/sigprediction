import type { ArbitrageOpportunity } from "./arbitrage";
import { round } from "./orderbook";

// Capital allocation across simultaneous arbitrage sets.
//
// Each set exposes a depth ladder of tranches (sets available at a marginal cost). We pool every
// tranche of every set and fund them in order of expected return on locked capital. This is the
// greedy solution to a fractional knapsack, which is optimal when the only constraints are
// capital budgets: the most efficient opportunity is funded first, deeper (worse) levels of it
// compete fairly with the top of other sets, and with ample capital every profitable set opens.
//
// Expected payout = guaranteed payout x convergence probability. For a buy-all-NO set the payout
// is contractually guaranteed (convergence 1). A buy-all-YES set only pays if one of the listed
// parties wins, so its convergence probability is the estimated chance that a listed party wins.

export interface ArbCandidate {
  arb: ArbitrageOpportunity;
  /** probability the set pays its guaranteed payout (1 for unconditional sets) */
  convergence: number;
  /** days until the capital is released (settlement), used to compare returns per unit time */
  daysToSettlement: number;
}

export interface ArbAllocation {
  arb: ArbitrageOpportunity;
  quantity: number;
  cost: number;
  expectedProfit: number;
  expectedReturn: number; // expected profit / cost
  annualizedReturn: number;
  convergence: number;
  limitedBy: "depth" | "budget" | "race_cap" | "min_quantity";
}

export interface AllocationLimits {
  /** total capital available for new arbitrage */
  budget: number;
  /** remaining capital allowed per race (correlated legs share one cap) */
  raceCap: (raceId: string) => number;
  minQuantity: number;
  /** minimum expected return on capital for a tranche to be funded */
  minReturn: number;
}

export function allocateArbitrage(cands: ArbCandidate[], lim: AllocationLimits): ArbAllocation[] {
  type T = { i: number; qty: number; cost: number; ret: number; ann: number };
  const pool: T[] = [];
  cands.forEach((c, i) => {
    const payout = c.arb.guaranteedPayoutPerSet * c.convergence;
    for (const t of c.arb.tranches) {
      const ret = (payout - t.costPerSet) / t.costPerSet;
      if (ret < lim.minReturn) continue;
      pool.push({ i, qty: t.quantity, cost: t.costPerSet, ret, ann: ret * (365 / Math.max(1, c.daysToSettlement)) });
    }
  });
  // Best return on capital first; ties go to the deeper (larger) tranche.
  pool.sort((a, b) => b.ann - a.ann || b.qty - a.qty);

  let budget = Math.max(0, lim.budget);
  const raceLeft = new Map<string, number>();
  const taken = cands.map(() => ({ q: 0, cost: 0, limited: "depth" as ArbAllocation["limitedBy"] }));
  for (const t of pool) {
    if (budget <= 0) break;
    const c = cands[t.i];
    const race = c.arb.raceId;
    if (!raceLeft.has(race)) raceLeft.set(race, Math.max(0, lim.raceCap(race)));
    const left = raceLeft.get(race)!;
    const byBudget = Math.floor(budget / t.cost);
    const byRace = Math.floor(left / t.cost);
    const q = Math.min(t.qty, byBudget, byRace);
    if (q < t.qty) taken[t.i].limited = byRace <= byBudget ? "race_cap" : "budget";
    if (q <= 0) continue;
    taken[t.i].q += q;
    taken[t.i].cost += q * t.cost;
    budget -= q * t.cost;
    raceLeft.set(race, left - q * t.cost);
  }

  const out: ArbAllocation[] = [];
  cands.forEach((c, i) => {
    const { q, cost, limited } = taken[i];
    if (q <= 0) return;
    if (q < lim.minQuantity) {
      // Too small to be worth executing; skipped (its capital simply stays unspent this tick).
      return;
    }
    const payout = q * c.arb.guaranteedPayoutPerSet * c.convergence;
    const profit = payout - cost;
    const ret = cost > 0 ? profit / cost : 0;
    out.push({
      arb: c.arb,
      quantity: q,
      cost: round(cost, 2),
      expectedProfit: round(profit, 2),
      expectedReturn: round(ret, 5),
      annualizedReturn: round(ret * (365 / Math.max(1, c.daysToSettlement)), 4),
      convergence: c.convergence,
      limitedBy: limited,
    });
  });
  return out.sort((a, b) => b.expectedProfit - a.expectedProfit);
}
