import { fail, ok, statefulGuard } from "@/lib/server/http";
import { marketsTable } from "@/lib/server/live";
import { discrepancy } from "@/lib/server/external";
import { statefulMode } from "@/lib/server/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  // The SIG read budget is per account: only the bot host reads SIG (Vercel proxies or declines).
  const g = await statefulGuard(req);
  if (g) return g;
  try {
    const t = await marketsTable();
    let history: ((m: string, v: string) => number[]) | null = null;
    if (statefulMode() === "local") {
      const { discrepancyHistory } = await import("@/lib/server/store");
      history = discrepancyHistory;
    }
    const rows = t.rows
      .flatMap((r) =>
        r.external.map((x) => ({
          marketId: r.id,
          title: r.title,
          race: r.race,
          sigBid: r.bid,
          sigAsk: r.ask,
          sigMid: r.mid,
          venue: x.venue,
          externalId: x.externalId,
          question: x.question,
          extBid: x.bid,
          extAsk: x.ask,
          extMid: x.mid,
          volume: x.volume,
          url: x.url,
          matchQuality: x.matchQuality,
          criteriaNote: x.criteriaNote,
          // Executable gap: can we buy on SIG below the external bid, or sell above its ask?
          buySigEdge: r.ask !== null && x.bid !== null ? +(x.bid - r.ask).toFixed(4) : null,
          sellSigEdge: r.bid !== null && x.ask !== null ? +(r.bid - x.ask).toFixed(4) : null,
          stats: discrepancy(r.mid, x, history ? history(r.id, x.venue) : []),
        })),
      )
      .sort((a, b) => Math.abs(b.stats?.priceDiff ?? 0) - Math.abs(a.stats?.priceDiff ?? 0));
    return ok({ fetchedAt: t.externalFetchedAt, matchedMarkets: t.matched, totalMarkets: t.total, rows });
  } catch (e) {
    return fail(e);
  }
}
