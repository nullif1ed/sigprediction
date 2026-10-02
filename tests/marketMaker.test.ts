import { describe, expect, it } from "vitest";
import { MarketMaker } from "@/lib/server/marketMaker";
import { SigClient } from "@/lib/server/sigClient";
import { parseSigTitle } from "@/lib/core/races";
import type { SigMarket, YesBook } from "@/lib/core/types";
import { book } from "./helpers";

const mk = (id: string, ex: string, title: string): SigMarket => ({ id, exchangeId: ex, title, status: "open", settlementDate: "2026-11-04T17:00:00Z", categories: [], race: parseSigTitle(title), latestPrice: null });
const DE = mk("386", "1075", "Will the Republican Party win the Delaware Senate?");
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** Fake SIG: resting orders live in `orders`; tests fill them by hand. */
function fake() {
  const orders = new Map<number, { side: string; action: string; quantity: number; price: number; open: boolean }>();
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let id = 100;
  const fetchFn = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const path = u.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    if (method === "POST" && path === "/orders") {
      const oid = ++id;
      orders.set(oid, { side: body.side, action: body.action, quantity: body.quantity, price: body.price, open: true });
      return json({ orderId: oid, exchangeId: body.exchangeId, open: true, remainingQuantity: body.quantity, quantityTraded: 0, totalCost: 0, fillPrice: null });
    }
    if (method === "DELETE") {
      const o = orders.get(Number(path.split("/").pop()));
      if (o) o.open = false;
      return json({ orderId: 1, message: "ok" });
    }
    if (path === "/orders/cancel-all") {
      for (const o of orders.values()) o.open = false;
      return json({ cancelled: 1 });
    }
    if (path === "/orders" && method === "GET") return json({ data: [...orders].filter(([, o]) => o.open).map(([oid, o]) => ({ id: oid, exchangeId: "1075", ...o, priceLimit: o.price })) });
    const m = /^\/orders\/(\d+)$/.exec(path);
    if (m) {
      const o = orders.get(Number(m[1]))!;
      return json({ id: Number(m[1]), quantity: o.quantity, open: o.open });
    }
    if (path.includes("/trades")) {
      const now = Date.now();
      return json({ data: Array.from({ length: 20 }, (_, i) => ({ id: String(i), createdAt: new Date(now - i * 60_000).toISOString(), price: 0.5, size: 1000, side: "YES" })) });
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  };
  const client = new SigClient({ apiKey: "k", baseUrl: "https://sig.test/api/v1", fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} });
  return { client, orders, calls };
}

async function started(books: { b: YesBook }) {
  const f = fake();
  const mm = new MarketMaker(f.client, "t1", () => books.b, () => null, "test");
  await mm.select([DE], new Set(), new Set());
  return { ...f, mm };
}

describe("market-making experiment", () => {
  it("quotes one tick inside the spread on both sides, YES terms", async () => {
    const books = { b: book("386", [[0.5, 1000]], [[0.545, 1000]]) };
    const t = await started(books);
    expect(t.mm.stats.status).toBe("running");
    await t.mm.cycle();
    const placed = t.calls.filter((c) => c.method === "POST" && c.path === "/orders").map((c) => c.body as { action: string; side: string; price: number; quantity: number });
    expect(placed).toEqual([
      expect.objectContaining({ action: "buy", side: "yes", price: 0.505, quantity: 500 }),
      expect.objectContaining({ action: "sell", side: "yes", price: 0.54, quantity: 500 }),
    ]);
  });

  it("ignores its own resting quote when finding the best price (does not chase itself)", async () => {
    const books = { b: book("386", [[0.5, 1000]], [[0.545, 1000]]) };
    const t = await started(books);
    await t.mm.cycle();
    // The book now shows our 0.905 bid and 0.94 ask on top; others are unchanged.
    books.b = book("386", [[0.505, 500], [0.5, 1000]], [[0.54, 500], [0.545, 1000]]);
    const before = t.calls.length;
    await t.mm.cycle();
    expect(t.calls.slice(before).filter((c) => c.method !== "GET")).toHaveLength(0); // nothing re-quoted
  });

  it("books fills, skews after inventory builds, stops buying at the position limit, and flattens at the end", async () => {
    const books = { b: book("386", [[0.5, 1000]], [[0.545, 1000]]) };
    const t = await started(books);
    for (let i = 0; i < 4; i++) {
      await t.mm.cycle();
      // Our bid gets hit in full each time.
      for (const o of t.orders.values()) if (o.open && o.action === "buy") Object.assign(o, { quantity: 0, open: false });
      books.b = book("386", [[0.5, 1000]], [[0.545, 1000]]);
    }
    await t.mm.cycle();
    expect(t.mm.stats.markets[0].inv).toBe(2000);
    // At the limit there is no resting bid any more, only an ask.
    const open = [...t.orders.values()].filter((o) => o.open);
    expect(open.every((o) => o.action === "sell")).toBe(true);
    expect(t.mm.stats.sharesTraded).toBe(2000);
    expect(t.mm.stats.spreadCaptured).toBeGreaterThan(0);
    await t.mm.finish("test");
    expect(t.mm.stats.status).toBe("finished");
    const flatten = t.calls.filter((c) => c.method === "POST" && c.path === "/orders").pop()!.body as { action: string; quantity: number; price: number };
    expect(flatten).toMatchObject({ action: "sell", quantity: 2000 });
    expect(flatten.price).toBeCloseTo(0.49);
    expect(t.mm.skip().has("386")).toBe(true); // leftover inventory stays out of the arb engine
  });

  it("refuses markets that are too tight or in a busy race", async () => {
    const f = fake();
    const tight = new MarketMaker(f.client, "t1", () => book("386", [[0.5, 1000]], [[0.51, 1000]]), () => null, "x");
    await tight.select([DE], new Set(), new Set());
    expect(tight.stats.status).toBe("failed");
    const busy = new MarketMaker(f.client, "t1", () => book("386", [[0.5, 1000]], [[0.545, 1000]]), () => null, "y");
    await busy.select([DE], new Set(["2026:SENATE:DE"]), new Set());
    expect(busy.stats.status).toBe("failed");
  });
});
