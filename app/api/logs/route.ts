import { ok, statefulGuard } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await statefulGuard(req);
  if (g) return g;
  const q = new URL(req.url).searchParams;
  const { recentLogs } = await import("@/lib/server/store");
  return ok({ logs: recentLogs(Math.min(1000, Number(q.get("limit") ?? 200)), q.get("level") ?? undefined) });
}
