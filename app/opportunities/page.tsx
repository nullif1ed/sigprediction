"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionBadge, Badge, Card, ErrorBox, fmt, Td, Th, useApi } from "@/components/ui";

interface Opp {
  marketId: string;
  title: string;
  action: string;
  opportunityType: string;
  executablePrice: number;
  vwap: number;
  fairValue: number;
  grossEdge: number;
  spreadCost: number;
  slippage: number;
  transactionCosts: number;
  netEdge: number;
  expectedReturn: number;
  confidence: number;
  availableQuantity: number;
  evaluatedQuantity: number;
  maxLossPerShare: number;
  riskAdjustedScore: number;
  equivalentTo: string[];
  reason: string;
}
interface Arb {
  kind: string;
  raceId: string;
  legs: { marketId: string; action: string; price: number; quantity: number }[];
  quantity: number;
  costPerSet: number;
  guaranteedPayoutPerSet: number;
  profitPerSet: number;
  totalProfit: number;
  conditional: boolean;
  note: string;
}

export default function Opportunities() {
  const [minEdge, setMinEdge] = useState(0.01);
  const [minConf, setMinConf] = useState(0.4);
  const [action, setAction] = useState("");
  const { data, error, loading } = useApi<{ asOf: string; opportunities: Opp[]; arbitrage: Arb[]; screenedCount: number; depthChecked: number }>(
    `/api/opportunities?minEdge=${minEdge}&minConfidence=${minConf}&depth=10`,
    30000,
  );
  const rows = (data?.opportunities ?? []).filter((o) => !action || o.action === action);

  return (
    <div className="space-y-4">
      <Card
        title="Ranked opportunities (live scan, paper decisions only)"
        right={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label>
              min net edge{" "}
              <input type="number" step={0.005} className="w-20 rounded border px-1" value={minEdge} onChange={(e) => setMinEdge(Number(e.target.value))} />
            </label>
            <label>
              min confidence{" "}
              <input type="number" step={0.05} className="w-20 rounded border px-1" value={minConf} onChange={(e) => setMinConf(Number(e.target.value))} />
            </label>
            <select className="rounded border px-1" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">all actions</option>
              {["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            {loading && <span className="text-xs text-slate-400">scanning…</span>}
          </div>
        }
      >
        <ErrorBox error={error} />
        <p className="mb-2 text-xs text-slate-500">
          Net edge = contract fair − VWAP (gross edge − half spread − slippage; SIG charges no fees). The whole universe is screened on top of book, then the best{" "}
          {data?.depthChecked ?? "–"} markets are re-priced against real depth. An unbacked SELL is listed under its equivalent BUY.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px]">
            <thead>
              <tr>
                <Th>Market</Th>
                <Th>Action</Th>
                <Th>Price</Th>
                <Th>VWAP</Th>
                <Th>Fair</Th>
                <Th>Gross</Th>
                <Th>Costs</Th>
                <Th>Net edge</Th>
                <Th>Exp. return</Th>
                <Th>Conf.</Th>
                <Th>Liquidity</Th>
                <Th>Score</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.marketId + o.action} className="hover:bg-slate-50">
                  <Td>
                    <Link className="text-blue-700" href={`/markets/${o.marketId}`}>
                      {o.title}
                    </Link>
                    <details className="text-xs text-slate-500">
                      <summary className="cursor-pointer">why</summary>
                      {o.reason}
                    </details>
                  </Td>
                  <Td>
                    <ActionBadge action={o.action} />
                  </Td>
                  <Td>{fmt.p(o.executablePrice)}</Td>
                  <Td>{fmt.p(o.vwap)}</Td>
                  <Td>{fmt.p(o.fairValue)}</Td>
                  <Td>{fmt.pp(o.grossEdge, 2)}</Td>
                  <Td>{fmt.p(o.spreadCost + o.slippage + o.transactionCosts)}</Td>
                  <Td className="font-semibold text-emerald-700">{fmt.pp(o.netEdge, 2)}</Td>
                  <Td>{fmt.pct(o.expectedReturn)}</Td>
                  <Td>{fmt.p(o.confidence, 2)}</Td>
                  <Td>{fmt.n(o.availableQuantity)}</Td>
                  <Td>{fmt.p(o.riskAdjustedScore, 2)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !rows.length && <p className="mt-2 text-sm text-slate-500">Nothing clears the thresholds after realistic execution costs.</p>}
        {data && <p className="mt-2 text-xs text-slate-500">As of {fmt.t(data.asOf)} · {data.screenedCount} action/market pairs screened.</p>}
      </Card>

      <Card title="Arbitrage monitor">
        <p className="mb-2 text-xs text-slate-500">
          A single SIG market cannot show YES ask + NO ask &lt; 1 because its NO book is derived from the YES book. Mispricing can appear across mutually
          exclusive markets in one race (e.g. Democratic vs Republican for the same seat): if their YES bids sum above 1, buying NO on each locks in a profit.
        </p>
        {!data?.arbitrage.length ? (
          <p className="text-sm text-slate-500">No arbitrage sets right now.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <Th>Race</Th>
                <Th>Kind</Th>
                <Th>Legs</Th>
                <Th>Cost/set</Th>
                <Th>Payout/set</Th>
                <Th>Profit/set</Th>
                <Th>Sets</Th>
                <Th>Total</Th>
              </tr>
            </thead>
            <tbody>
              {data.arbitrage.map((a, i) => (
                <tr key={i}>
                  <Td>{a.raceId}</Td>
                  <Td>
                    <Badge tone={a.conditional ? "amber" : "green"}>{a.kind}</Badge>
                  </Td>
                  <Td className="text-xs">
                    {a.legs.map((l) => (
                      <div key={l.marketId + l.action}>
                        {l.action} #{l.marketId} @ {fmt.p(l.price)}
                      </div>
                    ))}
                  </Td>
                  <Td>{fmt.p(a.costPerSet)}</Td>
                  <Td>{a.guaranteedPayoutPerSet}</Td>
                  <Td className="text-emerald-700">{fmt.p(a.profitPerSet)}</Td>
                  <Td>{a.quantity}</Td>
                  <Td>{fmt.n(a.totalProfit, 2)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
