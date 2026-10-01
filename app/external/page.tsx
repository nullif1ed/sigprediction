"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Card, ErrorBox, fmt, Td, Th, useApi } from "@/components/ui";

interface Row {
  marketId: string;
  title: string;
  race: string | null;
  sigBid: number | null;
  sigAsk: number | null;
  sigMid: number | null;
  venue: string;
  question: string;
  extBid: number | null;
  extAsk: number | null;
  extMid: number | null;
  volume: number | null;
  url: string;
  matchQuality: string;
  criteriaNote: string;
  buySigEdge: number | null;
  sellSigEdge: number | null;
  stats: { priceDiff: number; liquidityAdjustedDiff: number; zScore: number | null; historicalMeanDiff: number | null; historicalSdDiff: number | null; samples: number } | null;
}

export default function External() {
  const { data, error, loading } = useApi<{ fetchedAt: string; matchedMarkets: number; totalMarkets: number; rows: Row[] }>("/api/external", 30000);
  const [venue, setVenue] = useState("");
  const [onlyExec, setOnlyExec] = useState(false);
  const rows = (data?.rows ?? []).filter((r) => (!venue || r.venue === venue) && (!onlyExec || (r.buySigEdge ?? 0) > 0 || (r.sellSigEdge ?? 0) > 0));

  return (
    <Card
      title={`Cross-venue comparison — ${data?.matchedMarkets ?? "…"} / ${data?.totalMarkets ?? "…"} SIG markets matched`}
      right={
        <div className="flex items-center gap-2 text-sm">
          <select className="rounded border px-1" value={venue} onChange={(e) => setVenue(e.target.value)}>
            <option value="">all venues</option>
            <option value="polymarket">Polymarket</option>
            <option value="kalshi">Kalshi</option>
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={onlyExec} onChange={(e) => setOnlyExec(e.target.checked)} /> executable gaps only
          </label>
          {loading && <span className="text-xs text-slate-400">refreshing…</span>}
        </div>
      }
    >
      <ErrorBox error={error} />
      <p className="mb-2 text-xs text-slate-500">
        Matched on race, office, state/district, party and election cycle (2028 contracts are excluded). External prices are a reference, not truth.
        &quot;Buy on SIG&quot; &gt; 0 means SIG&apos;s YES ask is below the external bid; &quot;Sell on SIG&quot; &gt; 0 means SIG&apos;s YES bid is above the external ask. Z-scores need
        collected history.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1150px]">
          <thead>
            <tr>
              <Th>SIG market</Th>
              <Th>Venue</Th>
              <Th>SIG bid/ask</Th>
              <Th>Ext bid/ask</Th>
              <Th>SIG mid</Th>
              <Th>Ext mid</Th>
              <Th>Diff</Th>
              <Th>Liq-adj</Th>
              <Th>Z</Th>
              <Th>Buy on SIG</Th>
              <Th>Sell on SIG</Th>
              <Th>Ext volume</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.marketId + r.venue} className="hover:bg-slate-50">
                <Td>
                  <Link className="text-blue-700" href={`/markets/${r.marketId}`}>
                    {r.title}
                  </Link>
                  <div className="text-xs text-slate-500" title={r.criteriaNote}>
                    <a href={r.url} target="_blank" rel="noreferrer" className="underline decoration-dotted">
                      {r.question}
                    </a>
                  </div>
                </Td>
                <Td>
                  <Badge tone={r.venue === "polymarket" ? "blue" : "violet"}>{r.venue}</Badge>{" "}
                  {r.matchQuality !== "equivalent" && <Badge tone="amber">{r.matchQuality}</Badge>}
                </Td>
                <Td>
                  {fmt.p(r.sigBid)} / {fmt.p(r.sigAsk)}
                </Td>
                <Td>
                  {fmt.p(r.extBid)} / {fmt.p(r.extAsk)}
                </Td>
                <Td>{fmt.p(r.sigMid)}</Td>
                <Td>{fmt.p(r.extMid)}</Td>
                <Td className={Math.abs(r.stats?.priceDiff ?? 0) >= 0.05 ? "font-semibold text-rose-600" : ""}>{fmt.pp(r.stats?.priceDiff)}</Td>
                <Td>{fmt.pp(r.stats?.liquidityAdjustedDiff)}</Td>
                <Td>{r.stats?.zScore ?? "–"}</Td>
                <Td className={(r.buySigEdge ?? 0) > 0 ? "font-semibold text-emerald-700" : "text-slate-400"}>{fmt.pp(r.buySigEdge)}</Td>
                <Td className={(r.sellSigEdge ?? 0) > 0 ? "font-semibold text-emerald-700" : "text-slate-400"}>{fmt.pp(r.sellSigEdge)}</Td>
                <Td>{fmt.n(r.volume)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <p className="mt-2 text-xs text-slate-500">Fetched {fmt.t(data.fetchedAt)}.</p>}
    </Card>
  );
}
