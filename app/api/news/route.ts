import { ok, statefulGuard } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await statefulGuard(req);
  if (g) return g;
  const { recentHeadlines, loadMarkets } = await import("@/lib/server/store");
  const { headlineImpact } = await import("@/lib/core/news");
  const titles = new Map(loadMarkets().map((m) => [m.id, m.title]));
  const now = Date.now();
  return ok({
    headlines: recentHeadlines(60).map((h) => ({ ...h, title_market: titles.get(h.marketId) ?? h.marketId, impact: headlineImpact(h, (now - Date.parse(h.firstSeenAt)) / 60000) })),
  });
}
