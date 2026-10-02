import { adminGuard, fail, ok, statefulGuard } from "@/lib/server/http";

export const dynamic = "force-dynamic";
// Market-selling every position can take a few minutes while SIG is slow.
export const maxDuration = 600;

/** Stop the bot, cancel every open order, market-sell every position on SIG. */
export async function POST(req: Request) {
  const g = (await statefulGuard(req)) ?? adminGuard(req);
  if (g) return g;
  const { collector } = await import("@/lib/server/collector");
  const { liquidateEverything, tournamentIdFor } = await import("@/lib/server/liquidate");
  try {
    const c = collector();
    // Stop first (also clears the auto-resume flag), so nothing re-enters while we sell.
    await c.stop("liquidate_all");
    const tid = await tournamentIdFor(c.client, c.tournamentId);
    return ok(await liquidateEverything(c.client, tid));
  } catch (e) {
    return fail(e);
  }
}
