"use client";

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ActionBadge, Badge, Card, ErrorBox, fmt, Stat, Td, Th, useApi } from "@/components/ui";

interface Level {
  price: number;
  quantity: number;
}
interface Detail {
  market: { id: string; title: string; settlementDate: string; status: string };
  raceLabel: string | null;
  book: { bids: Level[]; asks: Level[]; asOf: string } | null;
  stats: { bestBid: number | null; bestAsk: number | null; mid: number | null; spread: number | null; spreadPct: number | null; imbalance: number | null } | null;
  actions: Record<string, number | null>;
  fair: { fairProbability: number; confidence: number; lowerBound: number; upperBound: number; reasoning: string; components: { source: string; value: number; weight: number }[] } | null;
  opportunities: { action: string; vwap: number; fairValue: number; netEdge: number; grossEdge: number; spreadCost: number; slippage: number; expectedReturn: number; availableQuantity: number; riskAdjustedScore: number; equivalentTo: string[]; reason: string }[];
  external: { venue: string; question: string; bid: number | null; ask: number | null; mid: number | null; volume: number | null; url: string; matchQuality: string; criteriaNote: string; discrepancy: { priceDiff: number; liquidityAdjustedDiff: number; zScore: number | null } | null }[];
  news: { contextSummary: string | null; lastRefresh: string | null; headlines: { id: string; title: string; url: string; source: string; summary: string; publishedDate: string; relevanceExplanation: string; impact: { sentiment: number; credibility: number } }[] };
}

/** Book in the chosen contract's terms (NO = complement of the YES book). */
function sideBook(book: Detail["book"], contract: "YES" | "NO") {
  if (!book) return { asks: [] as Level[], bids: [] as Level[] };
  if (contract === "YES") return { asks: book.asks, bids: book.bids };
  return {
    asks: book.bids.map((l) => ({ price: +(1 - l.price).toFixed(4), quantity: l.quantity })),
    bids: book.asks.map((l) => ({ price: +(1 - l.price).toFixed(4), quantity: l.quantity })),
  };
}

function vwap(levels: Level[], q: number) {
  let left = q;
  let cost = 0;
  let filled = 0;
  for (const l of levels) {
    if (left <= 0) break;
    const t = Math.min(left, l.quantity);
    cost += t * l.price;
    filled += t;
    left -= t;
  }
  return { filled, avg: filled ? cost / filled : null, cost };
}

export default function MarketPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<Detail>(`/api/markets/${id}`, 15000);
  const [contract, setContract] = useState<"YES" | "NO">("YES");
  const [action, setAction] = useState("BUY_YES");
  const [qty, setQty] = useState(100);
  const sb = sideBook(data?.book ?? null, contract);
  const ticket = useMemo(() => {
    if (!data?.book) return null;
    const yes = sideBook(data.book, "YES");
    const no = sideBook(data.book, "NO");
    // SELL actions on a flat account are unbacked: SIG fills them as the complement BUY.
    const levels = { BUY_YES: yes.asks, SELL_YES: no.asks, BUY_NO: no.asks, SELL_NO: yes.asks }[action as "BUY_YES"] ?? [];
    const priceLevels = { BUY_YES: yes.asks, SELL_YES: yes.bids, BUY_NO: no.asks, SELL_NO: no.bids }[action as "BUY_YES"] ?? [];
    return { cost: vwap(levels, qty), quoted: vwap(priceLevels, qty) };
  }, [data, action, qty]);
  const maxQty = Math.max(1, ...[...sb.asks, ...sb.bids].map((l) => l.quantity));

  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <Card title={data.market.title} right={<Badge tone="blue">{data.raceLabel ?? "unparsed"}</Badge>}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
          <Stat label="YES bid / ask" value={`${fmt.p(data.stats?.bestBid ?? null)} / ${fmt.p(data.stats?.bestAsk ?? null)}`} />
          <Stat label="Mid" value={fmt.p(data.stats?.mid ?? null)} sub={`spread ${fmt.pct(data.stats?.spreadPct ?? null)}`} />
          <Stat label="Fair value" value={fmt.p(data.fair?.fairProbability ?? null)} sub={data.fair ? `[${fmt.p(data.fair.lowerBound)}, ${fmt.p(data.fair.upperBound)}]` : ""} />
          <Stat label="Confidence" value={fmt.p(data.fair?.confidence ?? null, 2)} sub="in the estimate, not P(YES)" />
          <Stat label="Book imbalance" value={fmt.p(data.stats?.imbalance ?? null, 2)} />
          <Stat label="Settles" value={new Date(data.market.settlementDate).toLocaleDateString()} />
        </div>
        {data.fair && <p className="mt-2 text-xs text-slate-500">{data.fair.reasoning}</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Orderbook"
          right={
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm">
              {(["YES", "NO"] as const).map((c) => (
                <button key={c} onClick={() => setContract(c)} className={`rounded-md px-4 py-1 ${contract === c ? "bg-white shadow" : "text-slate-500"}`}>
                  {c}
                </button>
              ))}
            </div>
          }
        >
          <table className="w-full">
            <thead>
              <tr>
                <Th>Quantity</Th>
                <Th>Price</Th>
                <Th>Volume</Th>
              </tr>
            </thead>
            <tbody>
              {[...sb.asks].reverse().map((l) => (
                <tr key={"a" + l.price}>
                  <Td>{fmt.n(l.quantity)}</Td>
                  <Td className="text-rose-600">{fmt.p(l.price)}</Td>
                  <Td>
                    <div className="h-4 rounded bg-rose-100" style={{ width: `${(l.quantity / maxQty) * 100}%` }} />
                  </Td>
                </tr>
              ))}
              <tr>
                <Td className="bg-slate-50 text-xs text-slate-500">mid {fmt.p(contract === "YES" ? data.stats?.mid : data.stats?.mid != null ? 1 - data.stats.mid : null)}</Td>
                <Td className="bg-slate-50 text-xs text-slate-500">spread {fmt.p(data.stats?.spread ?? null)}</Td>
                <Td className="bg-slate-50" />
              </tr>
              {sb.bids.map((l) => (
                <tr key={"b" + l.price}>
                  <Td>{fmt.n(l.quantity)}</Td>
                  <Td className="text-emerald-600">{fmt.p(l.price)}</Td>
                  <Td>
                    <div className="h-4 rounded bg-emerald-100" style={{ width: `${(l.quantity / maxQty) * 100}%` }} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Action pricing (simulated ticket)">
          <div className="grid grid-cols-2 gap-2">
            {(["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO"] as const).map((a) => (
              <button key={a} onClick={() => setAction(a)} className={`rounded-lg border p-3 text-center ${action === a ? "border-blue-600 bg-blue-600 text-white" : "bg-white"}`}>
                <div className="text-sm">{a.replace("_", " ")}</div>
                <div className="text-lg font-semibold">{fmt.p(data.actions[a])}</div>
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-sm">
            Shares
            <input type="number" min={1} className="w-28 rounded border px-2 py-1" value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} />
          </div>
          {ticket && (
            <div className="mt-3 space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
              <div>
                Avg price ({action.replace("_", " ")}): <b>{fmt.p(ticket.quoted.avg)}</b> for {ticket.quoted.filled}/{qty} shares available
              </div>
              {action.startsWith("SELL") ? (
                <div className="text-slate-600">
                  With no {action.endsWith("YES") ? "YES" : "NO"} shares held this is an <b>unbacked sell</b>: you pay {fmt.p(ticket.cost.cost, 2)} SUSQies now and hold{" "}
                  {ticket.cost.filled} {action.endsWith("YES") ? "NO" : "YES"} shares — economically identical to {action.replace("_", " ")} at {fmt.p(ticket.quoted.avg)}.
                </div>
              ) : (
                <div className="text-slate-600">
                  Estimated net cost {fmt.p(ticket.cost.cost, 2)} SUSQies; payout if correct {ticket.cost.filled.toFixed(2)} SUSQies.
                </div>
              )}
              <div className="text-xs text-slate-500">Paper only. Walks displayed depth; never assumes the full size fills at the touch.</div>
            </div>
          )}
        </Card>
      </div>

      <Card title="All four actions vs fair value">
        <table className="w-full">
          <thead>
            <tr>
              <Th>Action</Th>
              <Th>VWAP</Th>
              <Th>Contract fair</Th>
              <Th>Gross edge</Th>
              <Th>Spread cost</Th>
              <Th>Slippage</Th>
              <Th>Net edge</Th>
              <Th>Exp. return</Th>
              <Th>Liquidity</Th>
              <Th>Score</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {data.opportunities.map((o) => (
              <tr key={o.action}>
                <Td>
                  <ActionBadge action={o.action} />
                </Td>
                <Td>{fmt.p(o.vwap)}</Td>
                <Td>{fmt.p(o.fairValue)}</Td>
                <Td>{fmt.pp(o.grossEdge, 2)}</Td>
                <Td>{fmt.p(o.spreadCost)}</Td>
                <Td>{fmt.p(o.slippage)}</Td>
                <Td className={o.netEdge > 0 ? "font-semibold text-emerald-700" : "text-slate-500"}>{fmt.pp(o.netEdge, 2)}</Td>
                <Td>{fmt.pct(o.expectedReturn)}</Td>
                <Td>{fmt.n(o.availableQuantity)}</Td>
                <Td>{fmt.p(o.riskAdjustedScore, 2)}</Td>
                <Td className="text-xs text-slate-500">{o.equivalentTo.length ? `≡ ${o.equivalentTo.join(", ")} when flat` : ""}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="External reference markets">
          {!data.external.length && <p className="text-sm text-slate-500">No equivalent Polymarket or Kalshi market found for this race.</p>}
          <ul className="space-y-3">
            {data.external.map((x) => (
              <li key={x.venue} className="text-sm">
                <div className="flex items-center gap-2">
                  <Badge tone={x.venue === "polymarket" ? "blue" : "violet"}>{x.venue}</Badge>
                  <Badge tone={x.matchQuality === "equivalent" ? "green" : "amber"}>{x.matchQuality}</Badge>
                  <a href={x.url} target="_blank" rel="noreferrer" className="text-blue-700">
                    {x.question}
                  </a>
                </div>
                <div className="mt-1 text-slate-600">
                  bid {fmt.p(x.bid)} / ask {fmt.p(x.ask)} / mid {fmt.p(x.mid)} · volume {fmt.n(x.volume)} · SIG−ext {fmt.pp(x.discrepancy?.priceDiff)} (liq-adj{" "}
                  {fmt.pp(x.discrepancy?.liquidityAdjustedDiff)})
                </div>
                <div className="text-xs text-slate-500">{x.criteriaNote}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Related news">
          {data.news.contextSummary && <p className="mb-2 text-sm text-slate-700">{data.news.contextSummary}</p>}
          <ul className="space-y-2">
            {data.news.headlines.map((h) => (
              <li key={h.id} className="text-sm">
                <Badge tone={h.impact.sentiment > 0.15 ? "green" : h.impact.sentiment < -0.15 ? "red" : "slate"}>{h.impact.sentiment.toFixed(2)}</Badge>{" "}
                <a href={h.url} target="_blank" rel="noreferrer" className="font-medium text-blue-700">
                  {h.title}
                </a>{" "}
                <span className="text-xs text-slate-500">
                  {h.source} · {h.publishedDate}
                </span>
                <div className="text-xs text-slate-500">{h.relevanceExplanation}</div>
              </li>
            ))}
          </ul>
          {data.news.lastRefresh && <p className="mt-2 text-xs text-slate-400">feed refreshed {fmt.t(data.news.lastRefresh)}</p>}
        </Card>
      </div>
    </div>
  );
}
