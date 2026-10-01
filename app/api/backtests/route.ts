import { adminGuard, body, fail, ok, statefulGuard } from "@/lib/server/http";
import type { BacktestRequest } from "@/lib/server/backtest";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await statefulGuard(req);
  if (g) return g;
  const { listSessions } = await import("@/lib/server/backtest");
  const { dataRange } = await import("@/lib/server/store");
  const { kvGet } = await import("@/lib/server/db");
  return ok({ sessions: listSessions(), data: dataRange(), scenarioRules: kvGet("scenario_rules", null) });
}

export async function POST(req: Request) {
  const g = (await statefulGuard(req)) ?? adminGuard(req);
  if (g) return g;
  const b = await body<BacktestRequest>(req);
  if (!b.strategy?.name) return ok({ error: { code: "VALIDATION_ERROR", message: "strategy.name is required" } }, { status: 400 });
  try {
    const { startBacktest } = await import("@/lib/server/backtest");
    return ok({ sessionId: startBacktest(b), status: "running" });
  } catch (e) {
    return fail(e);
  }
}
