import { adminGuard, body, fail, ok, statefulGuard } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await statefulGuard(req);
  if (g) return g;
  const { collector } = await import("@/lib/server/collector");
  const { dataRange } = await import("@/lib/server/store");
  const { db } = await import("@/lib/server/db");
  const runs = db().prepare("SELECT * FROM collector_runs ORDER BY id DESC LIMIT 20").all();
  return ok({ status: collector().status(), data: dataRange(), runs });
}

export async function POST(req: Request) {
  const g = (await statefulGuard(req)) ?? adminGuard(req);
  if (g) return g;
  const { collector } = await import("@/lib/server/collector");
  const b = await body<{ action?: string; paperTrading?: boolean; strategy?: Record<string, unknown> }>(req);
  try {
    if (b.action === "start") return ok(await collector().start({ paperTrading: b.paperTrading, strategy: b.strategy }));
    if (b.action === "stop") return ok(await collector().stop("user"));
    return ok({ error: { code: "VALIDATION_ERROR", message: "action must be start or stop" } }, { status: 400 });
  } catch (e) {
    return fail(e);
  }
}
