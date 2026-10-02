import { describe, expect, it } from "vitest";
import { PassiveUnwinder } from "@/lib/server/passiveUnwind";
import { SigClient } from "@/lib/server/sigClient";
import { Portfolio } from "@/lib/core/portfolio";
import { parseSigTitle } from "@/lib/core/races";
import type { SigMarket, YesBook } from "@/lib/core/types";
import { book } from "./helpers";

const mk = (id: string, ex: string, title: string): SigMarket => ({ id, exchangeId: ex, title, status: "open", settlementDate: "2026-11-04T17:00:00Z", categories: [], race: parseSigTitle(title), latestPrice: null });
const D = mk("293", "1001", "Will the Democratic Party win the Texas Senate?");
const R = mk("294", "1002", "Will the Republican Party win the Texas Senate?");
const markets = [D, R];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function fake() {
  const orders = new Map<number, { exchangeId: string; side: string; action: string; quantity: number; price: number; open: boolean }>();
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let id = 500;
  const fetchFn = async (url: string, init?: { method?: string; body?: string }) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    if (method === "POST" && path === "/orders") {
      const oid = ++id;
      // Y-leg sales (and anything marketable) fill at once in this fake; X rests.
      const fillNow = body.exchangeId === "1002";
      orders.set(oid, { ...body, quantity: fillNow ? 0 : body.quantity, open: !fillNow });
      return json({ orderId: oid, exchangeId: body.exchangeId, open: !fillNow, remainingQuantity: fillNow ? 0 : body.quantity, quantityTraded: fillNow ? body.quantity : 0, totalCost: 0, fillPrice: fillNow ? body.price : null });
    }
    if (method === "DELETE") {
      const o = orders.get(Number(path.split("/").pop()));
      if (o) o.open = false;
      return json({ orderId: 1, message: "ok" });
    }
    const m = /^\/orders\/(\d+)$/.exec(path);
    if (m) {
      const o = orders.get(Number(m[1]))!;
      return json({ id: Number(m[1]), quantity: o.quantity, open: o.open });
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  };
  return { client: new SigClient({ apiKey: "k", baseUrl: "https://sig.test/api/v1", fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }), orders, calls };
}

/** TX Senate on 2 Oct: 15,973 sets at 0.9906; sell-NO now 0.37 (D) + 0.615 (R) = 0.985 < cost. */
function setup() {
  const pf = new Portfolio(100_000);
  pf.applyFill("293", "BUY_NO", 15973, 0.3622, "t", { tradeType: "arbitrage" });
  pf.applyFill("294", "BUY_NO", 15973, 0.6284, "t", { tradeType: "arbitrage" });
  pf.markArb("293", "NO", 15973, 15973 * 0.3622);
  pf.markArb("294", "NO", 15973, 15973 * 0.6284);
  pf.arbSets.set("2026:SENATE:TX", ["293", "294"]);
  const books: Record<string, YesBook> = {
    // D YES 0.62/0.63 -> sell D-NO now at 0.37; R YES 0.375/0.385 -> sell R-NO now at 0.615 (5709 deep)
    "293": book("293", [[0.62, 4946]], [[0.63, 171], [0.635, 1087]]),
    "294": book("294", [[0.375, 500]], [[0.385, 5709], [0.4, 6]]),
  };
  const f = fake();
  const pu = new PassiveUnwinder(f.client, "t1", () => markets, () => pf, (id) => books[id]);
  return { ...f, pf, pu, books };
}

describe("passive unwind of large sets", () => {
  it("rests a sell on the leg needing the least improvement, priced to make the pair profitable", async () => {
    const t = setup();
    await t.pu.cycle();
    const placed = t.calls.filter((c) => c.method === "POST" && c.path === "/orders").map((c) => c.body as { exchangeId: string; side: string; action: string; price: number; quantity: number });
    expect(placed).toHaveLength(1);
    // cost 0.9906 + 0.2pp - 0.615 = 0.3776 -> 0.38 on tick: D-NO resting 1pp above its 0.37 bid-side sale.
    expect(placed[0]).toMatchObject({ exchangeId: "1001", side: "no", action: "sell", price: 0.38 });
    // Capped at 3000 per order (R-NO can absorb 5709 at its 0.615 limit).
    expect(placed[0].quantity).toBe(3000);
    expect(t.pu.owned()).toEqual(new Set(["293", "294"]));
  });

  it("sells exactly the filled quantity of the other leg, never below the profitable limit", async () => {
    const t = setup();
    await t.pu.cycle();
    const [oid, o] = [...t.orders].find(([, x]) => x.exchangeId === "1001")!;
    // 1200 of the resting D-NO sale fill.
    o.quantity = 1800;
    await t.pu.cycle();
    const y = t.calls.filter((c) => c.method === "POST" && (c.body as { exchangeId: string })?.exchangeId === "1002").map((c) => c.body as { quantity: number; price: number; action: string; side: string });
    expect(y).toHaveLength(1);
    expect(y[0]).toMatchObject({ side: "no", action: "sell", quantity: 1200, price: 0.615 });
    expect(t.pu.stats.setsClosed).toBe(1200);
    // 0.38 + 0.615 = 0.995 per set vs cost 0.9906: +0.0044 x 1200.
    expect(t.pu.stats.profit).toBeCloseTo(1200 * (0.995 - 0.9906), 1);
    void oid;
  });

  it("does nothing when the set is already sellable at a profit (the engine unwinds it) or hopeless", async () => {
    const t = setup();
    t.books["293"] = book("293", [[0.6, 5000]], [[0.61, 5000]]); // sell D-NO now 0.39: 0.39 + 0.615 > cost
    await t.pu.cycle();
    expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    t.books["293"] = book("293", [[0.66, 5000]], [[0.7, 5000]]); // needs > 2pp improvement on both legs
    t.books["294"] = book("294", [[0.3, 5000]], [[0.45, 5000]]);
    await t.pu.cycle();
    expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
