"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card, ErrorBox, fmt, Td, Th, useApi } from "@/components/ui";

interface Row {
  id: string;
  title: string;
  race: string | null;
  party: string | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  actions: { BUY_YES: number | null; SELL_YES: number | null; BUY_NO: number | null; SELL_NO: number | null };
  external: { venue: string; mid: number | null; diff: number | null; url: string }[];
  maxDivergence: number | null;
}

export default function Markets() {
  const { data, error, loading } = useApi<{ rows: Row[]; externalFetchedAt: string; matched: number; total: number }>("/api/markets", 15000);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"divergence" | "race" | "spread">("divergence");
  const rows = useMemo(() => {
    const r = (data?.rows ?? []).filter((x) => !q || x.title.toLowerCase().includes(q.toLowerCase()));
    if (sort === "divergence") return [...r].sort((a, b) => Math.abs(b.maxDivergence ?? 0) - Math.abs(a.maxDivergence ?? 0));
    if (sort === "spread") return [...r].sort((a, b) => (a.spread ?? 9) - (b.spread ?? 9));
    return [...r].sort((a, b) => (a.race ?? "").localeCompare(b.race ?? "") || (a.party ?? "").localeCompare(b.party ?? ""));
  }, [data, q, sort]);
  const ext = (r: Row, v: string) => r.external.find((x) => x.venue === v);

  return (
    <Card
      title={`Markets (${data?.total ?? "…"}) — ${data?.matched ?? 0} matched to Polymarket/Kalshi`}
      right={
        <div className="flex items-center gap-2">
          <input className="rounded border px-2 py-1 text-sm" placeholder="search" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="rounded border px-2 py-1 text-sm" value={sort} onChange={(e) => setSort(e.target.value as "race")}>
            <option value="divergence">sort: external divergence</option>
            <option value="race">sort: race</option>
            <option value="spread">sort: tightest spread</option>
          </select>
          {loading && <span className="text-xs text-slate-400">refreshing…</span>}
        </div>
      }
    >
      <ErrorBox error={error} />
      <p className="mb-2 text-xs text-slate-500">
        Every SIG market is one YES book; NO prices are derived (BUY NO = 1 − YES bid, SELL NO = 1 − YES ask). Divergence = SIG mid − external mid.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px]">
          <thead>
            <tr>
              <Th>Market</Th>
              <Th>Buy YES</Th>
              <Th>Sell YES</Th>
              <Th>Buy NO</Th>
              <Th>Sell NO</Th>
              <Th>Spread</Th>
              <Th>SIG mid</Th>
              <Th>Polymarket</Th>
              <Th>Kalshi</Th>
              <Th>Max divergence</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = ext(r, "polymarket");
              const k = ext(r, "kalshi");
              const d = r.maxDivergence;
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td>
                    <Link className="text-blue-700" href={`/markets/${r.id}`}>
                      {r.title}
                    </Link>
                  </Td>
                  <Td>{fmt.p(r.actions.BUY_YES)}</Td>
                  <Td>{fmt.p(r.actions.SELL_YES)}</Td>
                  <Td>{fmt.p(r.actions.BUY_NO)}</Td>
                  <Td>{fmt.p(r.actions.SELL_NO)}</Td>
                  <Td>{fmt.p(r.spread)}</Td>
                  <Td>{fmt.p(r.mid)}</Td>
                  <Td>{p ? <a className="text-slate-700 underline decoration-dotted" href={p.url} target="_blank" rel="noreferrer">{fmt.p(p.mid)}</a> : "–"}</Td>
                  <Td>{k ? <a className="text-slate-700 underline decoration-dotted" href={k.url} target="_blank" rel="noreferrer">{fmt.p(k.mid)}</a> : "–"}</Td>
                  <Td className={d === null ? "" : Math.abs(d) >= 0.05 ? "font-semibold text-rose-600" : Math.abs(d) >= 0.02 ? "text-amber-700" : "text-slate-600"}>
                    {fmt.pp(d)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && <p className="mt-2 text-xs text-slate-500">External quotes fetched {fmt.t(data.externalFetchedAt)}.</p>}
    </Card>
  );
}
