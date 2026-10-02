import { fail, ok, statefulGuard } from "@/lib/server/http";
import { scanOpportunities } from "@/lib/server/live";
import { mergeStrategy } from "@/lib/core/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const g = await statefulGuard(req);
  if (g) return g;
  const q = new URL(req.url).searchParams;
  const cfg = mergeStrategy({
    name: "live-scan",
    minNetEdge: Number(q.get("minEdge") ?? 0.01),
    minConfidence: Number(q.get("minConfidence") ?? 0.4),
  });
  try {
    const r = await scanOpportunities(cfg, Math.min(15, Number(q.get("depth") ?? 8)));
    return ok({ ...r, fair: undefined });
  } catch (e) {
    return fail(e);
  }
}
