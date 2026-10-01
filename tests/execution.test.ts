import { describe, expect, it } from "vitest";
import { PaperExecutionClient } from "@/lib/core/execution";
import { Portfolio } from "@/lib/core/portfolio";
import type { Fill } from "@/lib/core/types";
import { book } from "./helpers";

function setup() {
  const fills: Fill[] = [];
  const pf = new Portfolio(10_000);
  const ex = new PaperExecutionClient(pf, { onFill: (f) => fills.push(f) });
  let t = Date.parse("2026-10-01T16:00:00Z");
  ex.now = () => new Date(t);
  return { pf, ex, fills, advance: (ms: number) => (t += ms) };
}

describe("paper execution engine", () => {
  it("fills market orders against depth and cancels the unfilled remainder", () => {
    const { ex, fills, pf } = setup();
    ex.updateBook(book("1", [[0.4, 100]], [[0.5, 200], [0.52, 100]]));
    const o = ex.submitOrder({ marketId: "1", action: "BUY_YES", quantity: 500, orderType: "market" });
    expect(o.status).toBe("partially_filled");
    expect(o.filledQuantity).toBe(300);
    expect(o.fillPrice).toBeCloseTo((200 * 0.5 + 100 * 0.52) / 300);
    expect(o.notes).toMatch(/unfilled/);
    expect(fills).toHaveLength(1);
    expect(pf.holdings("1").YES).toBe(300);
    for (const k of ["orderId", "marketId", "action", "contract", "requestedQuantity", "filledQuantity", "fillPrice", "fees", "createdAt", "status"]) expect(o).toHaveProperty(k);
  });

  it("does not reuse liquidity it already consumed until the book changes", () => {
    const { ex } = setup();
    const b = book("1", [[0.4, 100]], [[0.5, 100]], "v1");
    ex.updateBook(b);
    expect(ex.submitOrder({ marketId: "1", action: "BUY_YES", quantity: 100, orderType: "market" }).filledQuantity).toBe(100);
    ex.updateBook(b); // same version
    expect(ex.submitOrder({ marketId: "1", action: "BUY_YES", quantity: 100, orderType: "market" }).status).toBe("cancelled");
    ex.updateBook(book("1", [[0.4, 100]], [[0.5, 100]], "v2"));
    expect(ex.submitOrder({ marketId: "1", action: "BUY_YES", quantity: 100, orderType: "market" }).filledQuantity).toBe(100);
  });

  it("rests limit orders, fills them when the book trades through, and expires them", () => {
    const { ex, advance } = setup();
    ex.updateBook(book("1", [[0.4, 100]], [[0.5, 100]], "v1"));
    const o = ex.submitOrder({ marketId: "1", action: "BUY_YES", quantity: 50, orderType: "limit", limitPrice: 0.45, expiresInSec: 60 });
    expect(o.status).toBe("pending");
    ex.updateBook(book("1", [[0.4, 100]], [[0.44, 30]], "v2"));
    expect(ex.getOrderStatus(o.orderId)!.filledQuantity).toBe(30);
    advance(61_000);
    ex.updateBook(book("1", [[0.4, 100]], [[0.5, 100]], "v3"));
    expect(ex.getOrderStatus(o.orderId)!.status).toBe("expired");
  });

  it("supports cancel and replace, and rejects without a book", () => {
    const { ex } = setup();
    ex.updateBook(book("1", [[0.4, 100]], [[0.5, 100]]));
    const o = ex.submitOrder({ marketId: "1", action: "BUY_NO", quantity: 10, orderType: "limit", limitPrice: 0.5 });
    const r = ex.replaceOrder(o.orderId, { limitPrice: 0.55 });
    expect(ex.getOrderStatus(o.orderId)!.status).toBe("cancelled");
    expect(r!.limitPrice).toBe(0.55);
    expect(ex.cancelOrder(r!.orderId)).toBe(true);
    expect(ex.submitOrder({ marketId: "9", action: "BUY_YES", quantity: 1, orderType: "market" }).status).toBe("rejected");
  });
});
