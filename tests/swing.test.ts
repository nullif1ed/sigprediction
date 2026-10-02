import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb } from "@/lib/server/db";
import { config } from "@/lib/server/config";
import { SwingCatcher } from "@/lib/server/swingCatcher";
import type { SigClient } from "@/lib/server/sigClient";
import type { Contract, SigMarket, YesBook } from "@/lib/core/types";
import { parseSigTitle } from "@/lib/core/races";
import { book } from "./helpers";

const mk = (id: string, exchangeId: string, title: string): SigMarket => ({ id, exchangeId, title, status: "open", settlementDate: "2026-11-04T00:00:00Z", categories: [], race: parseSigTitle(title) }) as unknown as SigMarket;
const markets = [mk("293", "e293", "Will the Democratic Party win the Texas Senate?"), mk("294", "e294", "Will the Republican Party win the Texas Senate?")];

/** Fake SIG: resting orders stay open until `fillAll`; immediate sells fill at the limit. */
function fake() {
  const orders = new Map<number, { side: string; action: string; quantity: number; price: number; open: boolean; exchangeId: string }>();
  const held = new Map<string, number>();
  let id = 0;
  const client = {
    writes: { available: () => 20 },
    async placeOrder(o: { exchangeId: string; side: string; action: string; quantity: number; price: number }) {
      id++;
      if (o.action === "sell") {
        const k = `${o.exchangeId}:${o.side}`;
        held.set(k, (held.get(k) ?? 0) - o.quantity);
        return { orderId: id, open: false, quantityTraded: o.quantity, fillPrice: o.price, remainingQuantity: 0 };
      }
      orders.set(id, { ...o, open: true });
      return { orderId: id, open: true, quantityTraded: 0, fillPrice: null, remainingQuantity: o.side === "no" ? -o.quantity : o.quantity }; // SIG signs NO remainders
    },
    async cancelOrder(i: number) {
      const o = orders.get(i);
      if (o) o.open = false;
      return {};
    },
    async getOrder(i: number) {
      const o = orders.get(i)!;
      return { id: i, quantity: o.quantity, open: o.open };
    },
    async openOrders() {
      return [...orders].filter(([, o]) => o.open).map(([i, o]) => ({ id: i, ...o }));
    },
  };
  const fill = (orderId: number) => {
    const o = orders.get(orderId)!;
    held.set(`${o.exchangeId}:${o.side}`, (held.get(`${o.exchangeId}:${o.side}`) ?? 0) + o.quantity);
    o.quantity = 0;
    o.open = false;
  };
  return { client: client as unknown as SigClient, orders, held, fill };
}

describe("swing catcher (deep resting orders)", () => {
  beforeEach(() => setDb(openDb(":memory:")));

  it("rests a YES bid and a NO bid SWING_DIST from the mid, then takes profit when the swing reverts", async () => {
    const f = fake();
    const books = new Map<string, YesBook>([
      ["293", book("293", [[0.6, 5000], [0.59, 5000]], [[0.61, 5000], [0.62, 5000]])],
      ["294", book("294", [[0.38, 5000]], [[0.39, 5000]])],
    ]);
    const held = (id: string, c: Contract) => f.held.get(`e${id}:${c.toLowerCase()}`) ?? 0;
    const sw = new SwingCatcher(f.client, "t", () => markets, (id) => books.get(id), () => new Set(), held, () => 100_000);
    await sw.cycle();
    const rest = [...f.orders.values()].filter((o) => o.exchangeId === "e293");
    // mid 0.605: YES bid at 0.555, NO bid at 1 - 0.605 - 0.05 = 0.345 (a YES ask at 0.655)
    expect(rest.map((o) => [o.side, o.price]).sort()).toEqual([["no", 0.345], ["yes", 0.555]]);
    // A second cycle keeps both quotes (no duplicates, even for the NO order's signed remainder).
    await sw.cycle();
    expect([...f.orders.values()].filter((o) => o.exchangeId === "e293" && o.open)).toHaveLength(2);
    // Only one market per race is quoted.
    expect([...f.orders.values()].some((o) => o.exchangeId === "e294")).toBe(false);

    // A sweep fills the YES bid; the NO quote is pulled.
    const yesId = [...f.orders].find(([, o]) => o.exchangeId === "e293" && o.side === "yes")![0];
    f.fill(yesId);
    books.set("293", book("293", [[0.55, 5000]], [[0.56, 5000]])); // the swing
    await sw.cycle();
    expect(sw.owned().has("293")).toBe(true);
    expect([...f.orders.values()].filter((o) => o.exchangeId === "e293" && o.open)).toHaveLength(0);

    // The price reverts: YES bid back at 0.6 >= entry 0.555 + 2.5pp -> sold at the bid.
    books.set("293", book("293", [[0.6, 5000]], [[0.61, 5000]]));
    await sw.cycle();
    expect(sw.owned().has("293")).toBe(false);
    expect(sw.stats.exits).toBe(1);
    expect(sw.stats.realized).toBeCloseTo(Math.floor(config.swingNotional / 0.555) * (0.6 - 0.555), 1);
  });

  it("never quotes a race the arbitrage engine holds", async () => {
    const f = fake();
    const books = new Map<string, YesBook>([["293", book("293", [[0.6, 5000]], [[0.61, 5000]])]]);
    const sw = new SwingCatcher(f.client, "t", () => markets, (id) => books.get(id), () => new Set(["2026:SENATE:TX"]), () => 0, () => 100_000);
    await sw.cycle();
    expect(f.orders.size).toBe(0);
  });

  it("keeps a fresh fill even before the portfolio has reconciled it", async () => {
    const f = fake();
    const books = new Map<string, YesBook>([["293", book("293", [[0.6, 5000]], [[0.61, 5000]])]]);
    const sw = new SwingCatcher(f.client, "t", () => markets, (id) => books.get(id), () => new Set(), () => 0, () => 100_000);
    await sw.cycle();
    const yesId = [...f.orders].find(([, o]) => o.side === "yes")![0];
    f.fill(yesId);
    books.set("293", book("293", [[0.55, 5000]], [[0.56, 5000]]));
    await sw.cycle(); // held() still reports 0: not reconciled yet
    await sw.cycle();
    expect(sw.owned().has("293")).toBe(true);
    // ...and no new bid is placed on a market holding a swing position.
    expect([...f.orders.values()].filter((o) => o.open)).toHaveLength(0);
  });
});
