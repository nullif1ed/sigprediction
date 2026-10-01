import { statefulGuard } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await statefulGuard(req);
  if (g) return g;
  const { id } = await ctx.params;
  const kind = (new URL(req.url).searchParams.get("kind") ?? "trades") as "trades" | "logs" | "equity";
  if (!["trades", "logs", "equity"].includes(kind)) return new Response("kind must be trades|logs|equity", { status: 400 });
  const { exportCsv } = await import("@/lib/server/backtest");
  return new Response(exportCsv(id, kind), {
    headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="backtest-${id.slice(0, 8)}-${kind}.csv"` },
  });
}
