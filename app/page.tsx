"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ActionBadge, api, Badge, Card, ErrorBox, fmt, LineChart, Notice, Stat, Td, Th, tone, useApi } from "@/components/ui";

interface Status {
  statefulMode: "local" | "proxy" | "unavailable";
  hasApiKey: boolean;
  tournament: string;
  rateLimits: { readsPerMinute: number; writesPerMinute: number; safety: number; source: string };
  polling: { priceIntervalSec: number; externalIntervalSec: number; newsMarketsPerMinute: number };
  adminTokenRequired: boolean;
}
interface CollectorResp {
  status: {
    running: boolean;
    startedAt: string | null;
    lastTickAt: string | null;
    ticks: number;
    markets: number;
    depthBooks: number;
    paperTrading: boolean;
    lastError: string | null;
    readsLastMinute: number;
    readBudgetPerMinute: number;
    rateLimited: number;
    priceIntervalSec: number;
    headlinesSeen: number;
  };
  data: { from: string | null; to: string | null; snapshots: number; markets: number };
}
interface Opp {
  marketId: string;
  title: string;
  action: string;
  opportunityType: string;
  vwap: number;
  fairValue: number;
  netEdge: number;
  confidence: number;
  riskAdjustedScore: number;
  availableQuantity: number;
}

function minutes(from: string | null, to: string | null) {
  if (!from || !to) return 0;
  return Math.round((Date.parse(to) - Date.parse(from)) / 60000);
}

export default function Dashboard() {
  const status = useApi<Status>("/api/status", 0);
  const stateful = status.data?.statefulMode !== "unavailable";
  const col = useApi<CollectorResp>(status.data && stateful ? "/api/collector" : null, 3000);
  const paper = useApi<{ snapshot: { equity: number; cash: number; realizedPnl: number; unrealizedPnl: number; drawdown: number; maxDrawdown: number; grossExposure: number; positions: number }; equity: { timestamp: string; equity: number }[]; orders: { order_id: string; created_at: string; title: string; action: string; filled_quantity: number; fill_price: number | null; status: string; tag: string | null }[] }>(
    status.data && stateful ? "/api/paper" : null,
    5000,
  );
  const opps = useApi<{ opportunities: Opp[]; arbitrage: { kind: string; raceId: string; profitPerSet: number; quantity: number }[]; asOf: string; screenedCount: number }>("/api/opportunities", 30000);
  const news = useApi<{ headlines: { id: string; title: string; source: string; title_market: string; marketId: string; firstSeenAt: string; impact: { direction: string; sentiment: number } }[] }>(
    status.data && stateful ? "/api/news" : null,
    30000,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [paperOn, setPaperOn] = useState(true);
  const [tok, setTok] = useState("");
  useEffect(() => setTok(localStorage.getItem("botToken") ?? ""), []);

  const s = col.data?.status;
  const control = async (action: "start" | "stop") => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/collector", { method: "POST", body: JSON.stringify({ action, paperTrading: paperOn }) });
      await col.reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <ErrorBox error={status.error} />
      {status.data && !status.data.hasApiKey && <Notice>SIG_API_KEY is not configured on this deployment; live data calls will fail.</Notice>}

      <Card
        title="Data collection"
        right={s ? <Badge tone={s.running ? "green" : "slate"}>{s.running ? "Collecting" : "Stopped"}</Badge> : null}
      >
        {status.data?.statefulMode === "unavailable" ? (
          <Notice>
            This deployment is serverless, so it cannot run the collector, paper trader or backtester. Live market, cross-venue and opportunity
            views below still work. For Day 1, run the app on your laptop (<code>npm run build && npm start</code>) and use the controls there; on
            Day 2 deploy it to a long-running host and set <code>BOT_BACKEND_URL</code> here to proxy to it.
          </Notice>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={busy || s?.running} onClick={() => control("start")} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
                Start collecting data
              </button>
              <button disabled={busy || !s?.running} onClick={() => control("stop")} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
                Stop collecting data
              </button>
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={paperOn} disabled={s?.running} onChange={(e) => setPaperOn(e.target.checked)} />
                Paper-trade live while collecting
              </label>
              {status.data?.adminTokenRequired && (
                <input
                  className="rounded border px-2 py-1 text-sm"
                  placeholder="bot token"
                  type="password"
                  value={tok}
                  onChange={(e) => {
                    setTok(e.target.value);
                    localStorage.setItem("botToken", e.target.value);
                  }}
                />
              )}
            </div>
            <ErrorBox error={err ?? col.error} />
            {s && col.data && (
              <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
                <Stat label="Data collected" value={`${minutes(col.data.data.from, col.data.data.to)} min`} sub={`${fmt.time(col.data.data.from)} → ${fmt.time(col.data.data.to)}`} />
                <Stat label="Snapshots" value={fmt.n(col.data.data.snapshots)} sub={`${col.data.data.markets} markets`} />
                <Stat label="Polling" value={`${s.priceIntervalSec}s`} sub={`${s.ticks} ticks, ${s.depthBooks} depth books`} />
                <Stat label="API reads / min" value={`${s.readsLastMinute} / ${s.readBudgetPerMinute}`} sub={`${s.rateLimited} rate-limit hits`} tone={s.readsLastMinute > s.readBudgetPerMinute * 0.95 ? "neg" : undefined} />
                <Stat label="Headlines seen" value={s.headlinesSeen} />
                <Stat label="Last tick" value={fmt.time(s.lastTickAt)} sub={s.paperTrading ? "paper trading on" : "collect only"} />
              </div>
            )}
            {s?.lastError && <ErrorBox error={`Last tick error: ${s.lastError}`} />}
          </div>
        )}
        {status.data && (
          <p className="mt-3 text-xs text-slate-500">
            Rate limit: {status.data.rateLimits.readsPerMinute} reads / {status.data.rateLimits.writesPerMinute} writes per minute per key, used at{" "}
            {Math.round(status.data.rateLimits.safety * 100)}% ({status.data.rateLimits.source}). Bulk prices cost ⌈markets/100⌉ reads per poll; the rest of the budget refreshes depth.
          </p>
        )}
      </Card>

      {paper.data && (
        <Card title="Paper portfolio" right={<Link className="text-sm text-blue-700" href="/portfolio">details →</Link>}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
            <Stat label="Equity" value={fmt.n(paper.data.snapshot.equity, 2)} sub="SUSQies (mid)" />
            <Stat label="Cash" value={fmt.n(paper.data.snapshot.cash, 2)} />
            <Stat label="Realized P&L" value={fmt.n(paper.data.snapshot.realizedPnl, 2)} tone={tone(paper.data.snapshot.realizedPnl)} />
            <Stat label="Unrealized P&L" value={fmt.n(paper.data.snapshot.unrealizedPnl, 2)} tone={tone(paper.data.snapshot.unrealizedPnl)} />
            <Stat label="Gross exposure" value={fmt.n(paper.data.snapshot.grossExposure, 0)} sub={`${paper.data.snapshot.positions} positions`} />
            <Stat label="Drawdown" value={fmt.pct(paper.data.snapshot.drawdown)} sub={`max ${fmt.pct(paper.data.snapshot.maxDrawdown)}`} />
          </div>
          <div className="mt-3">
            <LineChart series={[{ name: "equity", points: paper.data.equity.map((e) => ({ t: e.timestamp, v: e.equity })) }]} height={140} />
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top live opportunities" right={<Link className="text-sm text-blue-700" href="/opportunities">all →</Link>}>
          <ErrorBox error={opps.error} />
          {opps.data && (
            <>
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Market</Th>
                    <Th>Action</Th>
                    <Th>VWAP</Th>
                    <Th>Fair</Th>
                    <Th>Net edge</Th>
                    <Th>Score</Th>
                  </tr>
                </thead>
                <tbody>
                  {opps.data.opportunities.slice(0, 8).map((o) => (
                    <tr key={o.marketId + o.action}>
                      <Td>
                        <Link className="text-blue-700" href={`/markets/${o.marketId}`}>
                          {o.title.replace("Will the ", "").replace("?", "")}
                        </Link>
                      </Td>
                      <Td>
                        <ActionBadge action={o.action} />
                      </Td>
                      <Td>{fmt.p(o.vwap)}</Td>
                      <Td>{fmt.p(o.fairValue)}</Td>
                      <Td className="text-emerald-700">{fmt.pp(o.netEdge, 2)}</Td>
                      <Td>{fmt.p(o.riskAdjustedScore, 2)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!opps.data.opportunities.length && <p className="text-sm text-slate-500">No opportunity clears the net-edge threshold after spread and slippage.</p>}
              <p className="mt-2 text-xs text-slate-500">
                Screened {opps.data.screenedCount} action/market pairs at {fmt.time(opps.data.asOf)}; arbitrage sets found: {opps.data.arbitrage.length}.
              </p>
            </>
          )}
        </Card>

        <Card title="Recent paper trades" right={<Link className="text-sm text-blue-700" href="/orders">trade log →</Link>}>
          {!paper.data ? (
            <p className="text-sm text-slate-500">{stateful ? "Loading…" : "Available when running on a long-running host."}</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Market</Th>
                  <Th>Action</Th>
                  <Th>Filled</Th>
                  <Th>Price</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {paper.data.orders.slice(0, 10).map((o) => (
                  <tr key={o.order_id}>
                    <Td>{fmt.time(o.created_at)}</Td>
                    <Td className="max-w-48 truncate">{o.title}</Td>
                    <Td>
                      <ActionBadge action={o.action} />
                    </Td>
                    <Td>{o.filled_quantity}</Td>
                    <Td>{fmt.p(o.fill_price)}</Td>
                    <Td>
                      <Badge>{o.status}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {news.data && (
        <Card title="News feed (SIG related news)">
          <ul className="space-y-2">
            {news.data.headlines.slice(0, 12).map((h) => (
              <li key={h.id + h.marketId} className="text-sm">
                <Badge tone={h.impact.sentiment > 0.15 ? "green" : h.impact.sentiment < -0.15 ? "red" : "slate"}>{h.impact.sentiment.toFixed(2)}</Badge>{" "}
                <span className="font-medium">{h.title}</span> <span className="text-slate-500">— {h.source}</span>{" "}
                <Link className="text-xs text-blue-700" href={`/markets/${h.marketId}`}>
                  {h.title_market}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
