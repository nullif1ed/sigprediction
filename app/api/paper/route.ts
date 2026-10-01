import { adminGuard, body, ok, statefulGuard } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await statefulGuard(req);
  if (g) return g;
  const { db, kvGet, pj } = await import("@/lib/server/db");
  const { latestBooks, loadMarkets } = await import("@/lib/server/store");
  const { Portfolio, valuePosition } = await import("@/lib/core/portfolio");
  const { config } = await import("@/lib/server/config");
  const q = new URL(req.url).searchParams;
  const saved = kvGet<ReturnType<InstanceType<typeof Portfolio>["toJSON"]> | null>("paper_portfolio", null);
  const pf = saved ? Portfolio.fromJSON(saved) : new Portfolio(config.initialBankroll);
  const books = latestBooks();
  const titles = new Map(loadMarkets().map((m) => [m.id, m.title]));
  const snapshot = pf.snapshot(books, new Date().toISOString());
  const positions = pf.positions().map((p) => {
    const v = valuePosition(p, books.get(p.marketId));
    const cost = p.lots.reduce((s, l) => s + l.quantity * l.price, 0);
    return { ...p, title: titles.get(p.marketId) ?? p.marketId, markPrice: v.markPrice, exitPrice: v.exitPrice, marketValue: v.mid, unrealizedPnl: v.mid - cost, pctOfEquity: snapshot.equity ? cost / snapshot.equity : 0 };
  });
  const d = db();
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.get("status")) { where.push("status = ?"); args.push(q.get("status")); }
  if (q.get("action")) { where.push("action = ?"); args.push(q.get("action")); }
  if (q.get("marketId")) { where.push("market_id = ?"); args.push(q.get("marketId")); }
  const orders = d.prepare(`SELECT * FROM paper_orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 500`).all(...args)
    .map((o) => ({ ...o, title: titles.get(String(o.market_id)) ?? o.market_id }));
  const fills = d.prepare("SELECT * FROM paper_fills ORDER BY id DESC LIMIT 500").all();
  const decisions = d.prepare("SELECT payload FROM decisions ORDER BY id DESC LIMIT 200").all().map((r) => pj(r.payload, {}));
  const equity = d.prepare("SELECT payload FROM portfolio_snapshots ORDER BY id DESC LIMIT 1000").all().map((r) => pj<{ timestamp: string; equity: number }>(r.payload, { timestamp: "", equity: 0 })).reverse();
  return ok({ snapshot, positions, orders, fills, decisions, equity, executionMode: "paper" });
}

export async function POST(req: Request) {
  const g = (await statefulGuard(req)) ?? adminGuard(req);
  if (g) return g;
  const b = await body<{ action?: string }>(req);
  if (b.action !== "reset") return ok({ error: { code: "VALIDATION_ERROR", message: "action must be reset" } }, { status: 400 });
  const { collector } = await import("@/lib/server/collector");
  if (collector().running && collector().paperTrading)
    return ok({ error: { code: "CONFLICT", message: "Stop paper trading before resetting" } }, { status: 409 });
  const { db } = await import("@/lib/server/db");
  db().exec("DELETE FROM kv WHERE k IN ('paper_portfolio','paper_traded_headlines'); DELETE FROM paper_orders; DELETE FROM paper_fills; DELETE FROM decisions; DELETE FROM portfolio_snapshots;");
  return ok({ reset: true });
}
