"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionBadge, api, Badge, Card, ErrorBox, fmt, LineChart, Stat, Td, Th, tone, useApi } from "@/components/ui";

interface Paper {
  snapshot: { equity: number; liquidationEquity: number; cash: number; realizedPnl: number; unrealizedPnl: number; grossExposure: number; netExposure: number; drawdown: number; maxDrawdown: number; positions: number };
  positions: { marketId: string; title: string; contract: string; quantity: number; avgEntry: number; markPrice: number; exitPrice: number | null; marketValue: number; unrealizedPnl: number; pctOfEquity: number; openedAt: string; tradeType: string; entryFair: number | null }[];
  decisions: { timestamp: string; marketId: string; title: string; action: string; opportunityType: string; quantity: number; vwap: number; fairValue: number; netEdge: number; confidence: number; riskAdjustedScore: number; sizingStrategy: string; scenario: string; rejected?: string; reason: string; portfolioExposureAfter: number }[];
  equity: { timestamp: string; equity: number }[];
}

export default function PortfolioPage() {
  const { data, error, reload } = useApi<Paper>("/api/paper", 5000);
  const [msg, setMsg] = useState<string | null>(null);
  const reset = async () => {
    if (!confirm("Reset the paper portfolio to the initial bankroll? Orders, fills and decisions are deleted.")) return;
    try {
      await api("/api/paper", { method: "POST", body: JSON.stringify({ action: "reset" }) });
      setMsg("Paper portfolio reset.");
      reload();
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    }
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;
  const s = data.snapshot;
  return (
    <div className="space-y-4">
      <Card title="Paper portfolio (simulated SUSQies)" right={<button onClick={reset} className="rounded border px-2 py-1 text-xs text-rose-700">Reset</button>}>
        {msg && <p className="mb-2 text-sm">{msg}</p>}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Stat label="Equity (mid)" value={fmt.n(s.equity, 2)} sub={`liquidation ${fmt.n(s.liquidationEquity, 2)}`} />
          <Stat label="Cash" value={fmt.n(s.cash, 2)} />
          <Stat label="Realized P&L" value={fmt.n(s.realizedPnl, 2)} tone={tone(s.realizedPnl)} />
          <Stat label="Unrealized P&L" value={fmt.n(s.unrealizedPnl, 2)} tone={tone(s.unrealizedPnl)} />
          <Stat label="Drawdown" value={fmt.pct(s.drawdown)} sub={`max ${fmt.pct(s.maxDrawdown)}`} />
          <Stat label="Gross exposure" value={fmt.n(s.grossExposure, 0)} sub="cost basis" />
          <Stat label="Net exposure" value={fmt.n(s.netExposure, 0)} sub="YES − NO at mid" />
          <Stat label="Positions" value={s.positions} />
        </div>
        <div className="mt-3">
          <LineChart series={[{ name: "equity", points: data.equity.map((e) => ({ t: e.timestamp, v: e.equity })) }]} height={150} />
        </div>
      </Card>

      <Card title="Open positions">
        <table className="w-full">
          <thead>
            <tr>
              <Th>Market</Th>
              <Th>Contract</Th>
              <Th>Qty</Th>
              <Th>Avg entry</Th>
              <Th>Mark</Th>
              <Th>Exit price</Th>
              <Th>Value</Th>
              <Th>Unrealized</Th>
              <Th>% equity</Th>
              <Th>Type</Th>
              <Th>Opened</Th>
            </tr>
          </thead>
          <tbody>
            {data.positions.map((p) => (
              <tr key={p.marketId + p.contract}>
                <Td>
                  <Link className="text-blue-700" href={`/markets/${p.marketId}`}>
                    {p.title}
                  </Link>
                </Td>
                <Td>
                  <Badge tone={p.contract === "YES" ? "green" : "violet"}>{p.contract}</Badge>
                </Td>
                <Td>{fmt.n(p.quantity)}</Td>
                <Td>{fmt.p(p.avgEntry)}</Td>
                <Td>{fmt.p(p.markPrice)}</Td>
                <Td>{fmt.p(p.exitPrice)}</Td>
                <Td>{fmt.n(p.marketValue, 2)}</Td>
                <Td className={p.unrealizedPnl >= 0 ? "text-emerald-700" : "text-rose-600"}>{fmt.n(p.unrealizedPnl, 2)}</Td>
                <Td>{fmt.pct(p.pctOfEquity)}</Td>
                <Td>{p.tradeType}</Td>
                <Td>{fmt.t(p.openedAt)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.positions.length && <p className="text-sm text-slate-500">No open positions.</p>}
      </Card>

      <Card title="Trade decisions (why each trade was or was not taken)">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px]">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Market</Th>
                <Th>Action</Th>
                <Th>Type</Th>
                <Th>Qty</Th>
                <Th>VWAP</Th>
                <Th>Fair</Th>
                <Th>Net edge</Th>
                <Th>Conf.</Th>
                <Th>Score</Th>
                <Th>Sizing</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {data.decisions.map((d, i) => (
                <tr key={i}>
                  <Td>{fmt.time(d.timestamp)}</Td>
                  <Td className="max-w-72">
                    {d.title}
                    <details className="text-xs text-slate-500">
                      <summary className="cursor-pointer">reason</summary>
                      {d.reason} · scenario {d.scenario} · exposure after {fmt.pct(d.portfolioExposureAfter)}
                    </details>
                  </Td>
                  <Td>
                    <ActionBadge action={d.action} />
                  </Td>
                  <Td>{d.opportunityType}</Td>
                  <Td>{d.quantity}</Td>
                  <Td>{fmt.p(d.vwap)}</Td>
                  <Td>{fmt.p(d.fairValue)}</Td>
                  <Td>{fmt.pp(d.netEdge, 2)}</Td>
                  <Td>{fmt.p(d.confidence, 2)}</Td>
                  <Td>{fmt.p(d.riskAdjustedScore, 2)}</Td>
                  <Td>{d.sizingStrategy}</Td>
                  <Td>{d.rejected ? <Badge tone="red">{d.rejected}</Badge> : <Badge tone="green">submitted</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
