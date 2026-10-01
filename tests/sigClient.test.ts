import { describe, expect, it } from "vitest";
import { bookFromPrice, SigApiError, SigClient, toSigMarket, type RawMarket } from "@/lib/server/sigClient";
import { fixture } from "./helpers";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(responses: (Response | Error)[], calls: { url: string; init?: RequestInit }[] = []) {
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return new SigClient({ apiKey: "k", baseUrl: "https://x/api/v1", siteUrl: "https://x", fetchFn, sleep: async () => {}, readsPerMinute: 1000 });
}

describe("SIG API client", () => {
  it("sends the bearer key and paginates markets", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const page = fixture<{ data: RawMarket[] }>("sig-markets.json").data;
    const c = client(
      [json({ data: page.slice(0, 5), pagination: { hasMore: true, nextCursor: "abc" } }), json({ data: page.slice(5), pagination: { hasMore: false, nextCursor: null } })],
      calls,
    );
    const ms = await c.listMarkets("t1");
    expect(ms).toHaveLength(page.length);
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(calls[1].url).toContain("cursor=abc");
    expect(calls[0].url).toContain("tournamentId=t1");
  });

  it("backs off on 429 and retries 503", async () => {
    const c = client([
      json({ error: { code: "RATE_LIMITED", message: "slow down" } }, 429, { "retry-after": "1" }),
      json({ error: { code: "SERVICE_UNAVAILABLE", message: "busy" } }, 503),
      json({ id: "a", username: "u", balance: 100000 }),
    ]);
    expect((await c.account()).balance).toBe(100000);
    expect(c.rateLimited).toBe(1);
  });

  it("does not retry client errors and surfaces stable codes", async () => {
    const c = client([json({ error: { code: "INSUFFICIENT_SCOPES", message: "no" } }, 403)]);
    await expect(c.account()).rejects.toMatchObject({ status: 403, code: "INSUFFICIENT_SCOPES" });
    await expect(new SigClient({ apiKey: "" }).account()).rejects.toBeInstanceOf(SigApiError);
  });

  it("retries network errors (reconnect)", async () => {
    const c = client([new Error("ECONNRESET"), json({ id: "a", username: "u", balance: 1 })]);
    expect((await c.account()).balance).toBe(1);
  });

  it("normalises bulk prices, orderbooks and the news feed", async () => {
    const c = client([json(fixture("sig-prices.json")), json(fixture("sig-orderbook-381.json")), json(fixture("sig-news-381.json"))]);
    const ps = await c.prices(["1070"], "t");
    expect(ps.find((p) => p.marketId === "381")!.bestAsk).toBe(0.905);
    const b = (await c.orderbook("381", "t"))!;
    expect(b.asks[0]).toEqual({ price: 0.905, quantity: 1000 });
    expect(b.asOf).toContain("#");
    const n = await c.news("381");
    expect(n.headlines.length).toBeGreaterThan(0);
  });

  it("keeps known depth only while the touch is unchanged", () => {
    const prev = { exchangeId: "e", marketId: "381", bids: [{ price: 0.825, quantity: 1000 }], asks: [{ price: 0.905, quantity: 1000 }], asOf: "a" };
    const p = { exchangeId: "e", marketId: "381", option: "YES", latestPrice: null, bestBid: 0.825, bestAsk: 0.905, spread: 0.08 };
    expect(bookFromPrice(p, prev)).toBe(prev);
    const moved = bookFromPrice({ ...p, bestAsk: 0.9 }, prev);
    expect(moved.topOnly).toBe(true);
    expect(moved.asks).toHaveLength(0); // unknown size behind a new price: never assume liquidity
    expect(moved.bids[0].quantity).toBe(1000);
  });

  it("maps raw markets to normalised markets", () => {
    const m = toSigMarket(fixture<{ data: RawMarket[] }>("sig-markets.json").data.find((x) => x.id === "381")!);
    expect(m).toMatchObject({ exchangeId: "1070", race: { party: "D", office: "SENATE", state: "NH" } });
  });
});
