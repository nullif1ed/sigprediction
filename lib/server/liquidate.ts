import { randomUUID } from "node:crypto";
import { config } from "./config";
import { kvGet } from "./db";
import { log } from "./log";
import type { SigClient } from "./sigClient";

// "Liquidate everything" (dashboard button): flatten the SIG account in one action.
//  1. The caller stops the collector first, so the strategy cannot open new trades mid-way.
//  2. Cancel every open order in the tournament.
//  3. Market-sell every position (no price = SIG market order), several at once.
//  4. Re-read positions and repeat up to `passes` times for anything a thin book left over.
// Market orders take whatever the book offers: this realizes the spread (a loss on sets that
// would pay more at settlement). That is the point of the button: flat now, at any price.

export interface LiquidationResult {
  cancelledOrders: number;
  sells: { marketId: string; exchangeId: string; side: "yes" | "no"; quantity: number; filled: number; fillPrice: number | null; error?: string }[];
  positionsLeft: number;
  openOrdersLeft: number;
  accountValue: number | null;
  passes: number;
}

export async function liquidateEverything(client: SigClient, tournamentId: string, passes = 3): Promise<LiquidationResult> {
  const out: LiquidationResult = { cancelledOrders: 0, sells: [], positionsLeft: 0, openOrdersLeft: 0, accountValue: null, passes: 0 };
  try {
    out.cancelledOrders = (await client.cancelAll(tournamentId)).cancelled ?? 0;
  } catch (e) {
    log("ERROR", "live", "liquidate_cancel_failed", { error: String(e) });
  }
  for (let pass = 0; pass < passes; pass++) {
    const positions = (await client.tournamentPositions()).positions.filter((p) => !p.settled && Math.abs(p.quantity) >= 1);
    out.positionsLeft = positions.length;
    if (!positions.length) break;
    out.passes = pass + 1;
    const todo = [...positions];
    // 4 at a time: SIG takes seconds per order; the write limiter still caps the overall rate.
    await Promise.all(
      Array.from({ length: Math.min(4, todo.length) }, async () => {
        for (let p = todo.shift(); p; p = todo.shift()) {
          // Signed quantity: positive = YES shares, negative = NO shares.
          const side = p.quantity > 0 ? "yes" : "no";
          const quantity = Math.floor(Math.abs(p.quantity));
          try {
            const r = await client.placeOrder({ exchangeId: p.exchangeId, side, action: "sell", quantity, tournamentId, idempotencyKey: `liqall-${randomUUID()}` });
            out.sells.push({ marketId: p.marketId, exchangeId: p.exchangeId, side, quantity, filled: Number(r.quantityTraded ?? 0), fillPrice: r.fillPrice ?? null });
            log("WARNING", "live", "liquidate_market", { pass, marketId: p.marketId, side, quantity, filled: r.quantityTraded, fillPrice: r.fillPrice });
          } catch (e) {
            out.sells.push({ marketId: p.marketId, exchangeId: p.exchangeId, side, quantity, filled: 0, fillPrice: null, error: String(e).slice(0, 200) });
            log("ERROR", "live", "liquidate_market_failed", { pass, marketId: p.marketId, error: String(e) });
          }
        }
      }),
    );
  }
  try {
    out.positionsLeft = (await client.tournamentPositions()).positions.filter((p) => !p.settled && Math.abs(p.quantity) >= 1).length;
    out.openOrdersLeft = (await client.openOrders(tournamentId)).length;
    out.accountValue = (await client.tournamentPnl()).totalAccountValue ?? null;
  } catch (e) {
    log("ERROR", "live", "liquidate_verify_failed", { error: String(e) });
  }
  log("WARNING", "live", "liquidate_everything_done", { ...out, sells: out.sells.length });
  return out;
}

/** Tournament id without a SIG call when the collector already knows it. */
export async function tournamentIdFor(client: SigClient, known: string | null): Promise<string> {
  return known ?? kvGet<string | null>("tournament_id", null) ?? (await client.tournament(config.tournamentSlug)).id;
}
