import type { Action, Fill, PaperOrder, YesBook } from "./types";
import { consume, contractOf, isBuy, round, simulateExecution } from "./orderbook";
import { fillRecord, Portfolio, type OpenMeta } from "./portfolio";

/**
 * Isolated execution interface. The only implementation in this project is PAPER:
 * no code path places orders on SIG. A live client must implement this interface separately.
 */
export interface ExecutionClient {
  submitOrder(req: OrderRequest): PaperOrder;
  cancelOrder(orderId: string): boolean;
  getOrderStatus(orderId: string): PaperOrder | undefined;
}

export interface OrderRequest {
  marketId: string;
  action: Action;
  quantity: number;
  orderType: "market" | "limit";
  limitPrice?: number | null; // contract terms
  expiresInSec?: number | null;
  tag?: string;
  meta?: OpenMeta;
}

export interface ExecutionEvents {
  onFill?: (f: Fill, o: PaperOrder) => void;
  onOrder?: (o: PaperOrder) => void;
}

let seq = 0;
const newId = () => `paper-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/**
 * Paper execution against the current order-book snapshot.
 *  - market orders walk the book (partial fills, remainder cancelled, IOC semantics),
 *  - limit orders fill their marketable part and rest; resting orders fill only when a later book
 *    trades through their price (no queue priority is assumed: conservative),
 *  - liquidity consumed by our own fills stays consumed until the exchange publishes a new book,
 *  - SIG charges no fees in the contest; `feePerShare` exists for sensitivity tests.
 */
export class PaperExecutionClient implements ExecutionClient {
  private orders = new Map<string, PaperOrder>();
  private books = new Map<string, YesBook>(); // books net of our own simulated fills
  /**
   * Our fills never reach the real exchange, so a refreshed book still displays liquidity we
   * already took. Track consumption per price level and keep it until the displayed quantity at
   * that level changes (i.e. the real book moved). Prevents re-buying the same shares every poll.
   */
  private used = new Map<string, { shown: number; used: number }>();
  now: () => Date = () => new Date();

  constructor(
    public portfolio: Portfolio,
    private events: ExecutionEvents = {},
    private feePerShare = 0,
  ) {}

  /** Feed a fresh book; liquidity we already consumed stays consumed while the level is unchanged. */
  updateBook(book: YesBook) {
    const adjust = (side: "bids" | "asks") =>
      book[side]
        .map((l) => {
          const k = `${book.marketId}:${side}:${l.price}`;
          const u = this.used.get(k);
          if (!u) return l;
          if (u.shown !== l.quantity) {
            this.used.delete(k); // the real level changed: displayed size is fresh
            return l;
          }
          return { ...l, quantity: Math.max(0, l.quantity - u.used) };
        })
        .filter((l) => l.quantity > 0);
    this.books.set(book.marketId, { ...book, bids: adjust("bids"), asks: adjust("asks") });
    this.processResting(book.marketId);
    this.expire();
  }

  private recordUse(marketId: string, side: "bids" | "asks", before: YesBook, qty: number, original: Map<number, number>) {
    let left = qty;
    for (const l of before[side]) {
      if (left <= 0) break;
      const take = Math.min(left, l.quantity);
      const k = `${marketId}:${side}:${l.price}`;
      const u = this.used.get(k) ?? { shown: original.get(l.price) ?? l.quantity, used: 0 };
      u.used += take;
      this.used.set(k, u);
      left -= take;
    }
  }

  book(marketId: string): YesBook | undefined {
    return this.books.get(marketId);
  }

  submitOrder(req: OrderRequest): PaperOrder {
    const ts = this.now().toISOString();
    const o: PaperOrder = {
      orderId: newId(),
      marketId: req.marketId,
      action: req.action,
      contract: contractOf(req.action),
      orderType: req.orderType,
      limitPrice: req.orderType === "limit" ? (req.limitPrice ?? null) : null,
      requestedQuantity: Math.floor(req.quantity),
      filledQuantity: 0,
      fillPrice: null,
      fees: 0,
      status: "pending",
      createdAt: ts,
      updatedAt: ts,
      expiresAt: req.expiresInSec ? new Date(this.now().getTime() + req.expiresInSec * 1000).toISOString() : null,
      notes: "",
      tag: req.tag,
    };
    this.orders.set(o.orderId, o);
    (o as PaperOrder & { meta?: OpenMeta }).meta = req.meta;
    if (o.requestedQuantity <= 0) {
      o.status = "rejected";
      o.notes = "quantity must be positive";
    } else if (!this.books.has(o.marketId)) {
      o.status = "rejected";
      o.notes = "no order book available";
    } else {
      this.tryFill(o);
      if (o.orderType === "market" && o.status !== "filled") {
        o.status = o.filledQuantity > 0 ? "partially_filled" : "cancelled";
        o.notes = (o.notes ? o.notes + "; " : "") + `IOC: ${o.requestedQuantity - o.filledQuantity} unfilled (insufficient liquidity)`;
        // A partially-filled market order is terminal: mark remainder cancelled.
        if (o.filledQuantity > 0) o.status = "partially_filled";
      }
    }
    this.events.onOrder?.(o);
    return o;
  }

  private tryFill(o: PaperOrder) {
    const book = this.books.get(o.marketId);
    if (!book) return;
    const remaining = o.requestedQuantity - o.filledQuantity;
    const ex = simulateExecution(book, o.action, remaining, o.limitPrice);
    if (ex.filled <= 0 || ex.vwap === null) return;
    const meta = (o as PaperOrder & { meta?: OpenMeta }).meta ?? {};
    const ts = this.now().toISOString();
    const realized = this.portfolio.applyFill(o.marketId, o.action, ex.filled, ex.vwap, ts, { tradeType: "regular", ...meta });
    const fee = ex.filled * this.feePerShare;
    this.portfolio.cash -= fee;
    const prevNotional = (o.fillPrice ?? 0) * o.filledQuantity;
    o.filledQuantity += ex.filled;
    o.fillPrice = round((prevNotional + ex.vwap * ex.filled) / o.filledQuantity);
    o.fees = round(o.fees + fee, 4);
    o.status = o.filledQuantity >= o.requestedQuantity ? "filled" : "partially_filled";
    o.updatedAt = ts;
    if (ex.levelsUsed > 1) o.notes = `walked ${ex.levelsUsed} levels, slippage ${ex.slippage.toFixed(4)}`;
    const side: "bids" | "asks" = o.action === "BUY_YES" || o.action === "SELL_NO" ? "asks" : "bids";
    // Displayed (pre-consumption) sizes are the remaining size plus what we already used.
    const shown = new Map(book[side].map((l) => [l.price, l.quantity + (this.used.get(`${o.marketId}:${side}:${l.price}`)?.used ?? 0)]));
    this.recordUse(o.marketId, side, book, ex.filled, shown);
    this.books.set(o.marketId, consume(book, o.action, ex.filled));
    this.events.onFill?.(
      fillRecord({ orderId: o.orderId, marketId: o.marketId, action: o.action, quantity: ex.filled, price: ex.vwap, timestamp: ts, realizedPnl: round(realized, 4) }),
      o,
    );
  }

  private processResting(marketId: string) {
    for (const o of this.orders.values()) {
      if (o.marketId !== marketId || o.orderType !== "limit") continue;
      if (o.status !== "pending" && o.status !== "partially_filled") continue;
      this.tryFill(o);
      if ((o.status as string) === "filled") this.events.onOrder?.(o);
    }
  }

  private expire() {
    const now = this.now().getTime();
    for (const o of this.orders.values()) {
      if ((o.status === "pending" || o.status === "partially_filled") && o.orderType === "limit" && o.expiresAt && Date.parse(o.expiresAt) <= now) {
        o.status = "expired";
        o.updatedAt = new Date(now).toISOString();
        this.events.onOrder?.(o);
      }
    }
  }

  cancelOrder(orderId: string): boolean {
    const o = this.orders.get(orderId);
    if (!o || !(o.status === "pending" || (o.status === "partially_filled" && o.orderType === "limit"))) return false;
    o.status = "cancelled";
    o.updatedAt = this.now().toISOString();
    this.events.onOrder?.(o);
    return true;
  }

  replaceOrder(orderId: string, changes: Partial<Pick<OrderRequest, "quantity" | "limitPrice">>): PaperOrder | null {
    const o = this.orders.get(orderId);
    if (!o || !this.cancelOrder(orderId)) return null;
    return this.submitOrder({
      marketId: o.marketId,
      action: o.action,
      orderType: o.orderType,
      quantity: changes.quantity ?? o.requestedQuantity - o.filledQuantity,
      limitPrice: changes.limitPrice ?? o.limitPrice,
      tag: o.tag,
    });
  }

  getOrderStatus(orderId: string): PaperOrder | undefined {
    return this.orders.get(orderId);
  }

  openOrders(): PaperOrder[] {
    return [...this.orders.values()].filter((o) => o.orderType === "limit" && (o.status === "pending" || o.status === "partially_filled"));
  }

  isBuy = isBuy;
}
