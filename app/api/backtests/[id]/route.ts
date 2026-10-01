import { adminGuard, body, ok, statefulGuard } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await statefulGuard(req);
  if (g) return g;
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const { sessionDetail } = await import("@/lib/server/backtest");
  const d = sessionDetail(id, { logLevel: q.get("level") ?? undefined });
  if (!d) return ok({ error: { code: "NOT_FOUND", message: "session not found" } }, { status: 404 });
  return ok(d);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = (await statefulGuard(req)) ?? adminGuard(req);
  if (g) return g;
  const { id } = await ctx.params;
  const b = await body<{ action?: string }>(req);
  if (b.action !== "stop") return ok({ error: { code: "VALIDATION_ERROR", message: "action must be stop" } }, { status: 400 });
  const { stopBacktest } = await import("@/lib/server/backtest");
  return ok({ stopping: stopBacktest(id) });
}
