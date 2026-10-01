"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function token(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("botToken") ?? "";
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-bot-token": token(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `${res.status} ${res.statusText}`);
  return data as T;
}

/** Fetch JSON and optionally re-poll. Keeps the previous data while refreshing. */
export function useApi<T>(path: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    load();
    if (!intervalMs) return () => void (alive.current = false);
    const t = setInterval(load, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load, intervalMs]);
  return { data, error, loading, reload: load };
}

export function Card({ title, children, right, className = "" }: { title?: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "pos" | "neg" | "muted" }) {
  const c = tone === "pos" ? "text-emerald-600" : tone === "neg" ? "text-rose-600" : "text-slate-900";
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${c}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "red" | "blue" | "amber" | "violet" }) {
  const m = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-700",
    red: "bg-rose-100 text-rose-700",
    blue: "bg-blue-100 text-blue-700",
    amber: "bg-amber-100 text-amber-800",
    violet: "bg-violet-100 text-violet-700",
  }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${m}`}>{children}</span>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{children}</div>;
}

export const fmt = {
  p: (v: number | null | undefined, dp = 3) => (v === null || v === undefined || Number.isNaN(v) ? "–" : v.toFixed(dp)),
  pct: (v: number | null | undefined, dp = 2) => (v === null || v === undefined || Number.isNaN(v) ? "–" : `${(v * 100).toFixed(dp)}%`),
  pp: (v: number | null | undefined, dp = 1) => (v === null || v === undefined || Number.isNaN(v) ? "–" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(dp)}pp`),
  n: (v: number | null | undefined, dp = 0) =>
    v === null || v === undefined || Number.isNaN(v) ? "–" : v.toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp }),
  susq: (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} SUSQies`),
  t: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "–"),
  time: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString() : "–"),
};

export const tone = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? undefined : v > 0 ? "pos" : "neg");

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th className={`border-b border-slate-200 px-2 py-1.5 text-left text-xs font-medium text-slate-500 ${className}`}>{children}</th>;
}
export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`border-b border-slate-100 px-2 py-1.5 align-top text-sm tabular-nums ${className}`}>{children}</td>;
}

const COLORS = ["#2563eb", "#16a34a", "#d97706", "#7c3aed", "#db2777", "#0891b2"];

/** Minimal multi-series line chart (no chart library). */
export function LineChart({
  series,
  height = 180,
  baseline,
}: {
  series: { name: string; points: { t: string; v: number }[] }[];
  height?: number;
  baseline?: number;
}) {
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return <div className="flex h-24 items-center justify-center text-sm text-slate-400">Waiting for data…</div>;
  const ts = all.map((p) => Date.parse(p.t));
  const vs = all.map((p) => p.v).concat(baseline !== undefined ? [baseline] : []);
  const [t0, t1] = [Math.min(...ts), Math.max(...ts)];
  let [v0, v1] = [Math.min(...vs), Math.max(...vs)];
  if (v1 - v0 < 1e-9) {
    v0 -= 1;
    v1 += 1;
  }
  const W = 800;
  const H = height;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (W - 50) + 45;
  const y = (v: number) => H - 20 - ((v - v0) / (v1 - v0)) * (H - 35);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="line chart">
        {[v0, (v0 + v1) / 2, v1].map((v, i) => (
          <g key={i}>
            <line x1={45} x2={W - 5} y1={y(v)} y2={y(v)} stroke="#e2e8f0" />
            <text x={0} y={y(v) + 4} fontSize={11} fill="#64748b">
              {v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(3)}
            </text>
          </g>
        ))}
        {baseline !== undefined && <line x1={45} x2={W - 5} y1={y(baseline)} y2={y(baseline)} stroke="#94a3b8" strokeDasharray="4 4" />}
        {series.map((s, i) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={2}
            points={s.points.map((p) => `${x(Date.parse(p.t)).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
          />
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-xs">
        {series.map((s, i) => (
          <span key={s.name} className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded" style={{ background: COLORS[i % COLORS.length] }} />
            {s.name}
            {s.points.length ? <span className="text-slate-500"> {fmtLast(s.points[s.points.length - 1].v)}</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}
const fmtLast = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(3));

export function ActionBadge({ action }: { action: string }) {
  const t = action.startsWith("BUY") ? (action.endsWith("YES") ? "green" : "violet") : action.endsWith("YES") ? "red" : "amber";
  return <Badge tone={t as "green"}>{action.replace("_", " ")}</Badge>;
}
