"use client";

import { useState } from "react";
import { ActionBadge, api, Badge, Card, ErrorBox, fmt, LineChart, Notice, Stat, Td, Th, useApi } from "@/components/ui";

interface Metrics {
  startingCapital: number;
  endingCapital: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  winRate: number | null;
  profitFactor: number | null;
  averageTrade: number | null;
  numTrades: number;
  numClosedTrades: number;
  turnover: number;
  maxExposure: number;
  capitalUtilization: number;
  score: number;
}
interface Session {
  session_id: string;
  strategy_name: string;
  strategy_version: string;
  description: string | null;
  based_on: string | null;
  status: string;
  progress: number;
  data_from: string | null;
  data_to: string | null;
  started_at: string;
  bestPortfolio: string | null;
  best: Metrics | null;
  auto: Metrics | null;
}
interface Detail {
  session_id: string;
  strategy_name: string;
  description: string | null;
  status: string;
  progress: number;
  sim_time: string | null;
  data_from: string;
  data_to: string;
  started_at: string;
  running: boolean;
  error: string | null;
  strategy_config: Record<string, unknown>;
  results: {
    window: { ticks: number; stoppedEarly: boolean };
    portfolios: Record<string, Metrics>;
    bestPortfolio: string;
    signals: { headline: number; arbitrage: number; decisions: number; rejected: number };
    scenarioAnalysis: Record<string, { best: string; previousRule: string; strategies: { strategy: string; pnl: number; cost: number; trades: number; returnOnCapital: number }[] }>;
    decisionTree: { condition: string; strategy: string; trades: number; avgPnl: number }[];
  } | null;
  equity: Record<string, { t: string; equity: number; drawdown: number }[]>;
  trades: { id: number; portfolio: string; market_id: string; action: string; quantity: number; price: number; realized_pnl: number; tag: string; sim_ts: string }[];
  tradeCounts: Record<string, number>;
  logs: { id: number; sim_ts: string; level: string; message: string; context: Record<string, unknown> | null }[];
}

const DEFAULT_FORM = {
  name: "baseline",
  description: "Day-1 tuned defaults",
  minNetEdge: 0.01,
  minConfidence: 0.4,
  takeProfitPp: 0.01,
  stopLossPp: 0.04,
  minDaysToResolution: 1,
  kellyFraction: 0.25,
  fixedFraction: 0.01,
  maxPositionPct: 0.05,
  headlineTrading: true,
  arbitrage: true,
  replaySpeed: 0,
  latencyMs: 250,
  from: "",
  to: "",
  basedOn: "" as string,
};
type Form = typeof DEFAULT_FORM;

function toRequest(f: Form) {
  return {
    strategy: {
      name: f.name,
      description: f.description,
      minNetEdge: f.minNetEdge,
      minConfidence: f.minConfidence,
      headlineTrading: f.headlineTrading,
      arbitrage: f.arbitrage,
      // Absolute targets in probability points; the relative fallbacks are disabled for form runs.
      exits: { takeProfitPp: f.takeProfitPp, profitTarget: 1, stopLossPp: f.stopLossPp, stopLoss: 0, minDaysToResolution: f.minDaysToResolution },
      risk: { kellyFraction: f.kellyFraction, fixedFraction: f.fixedFraction, maxPositionPct: f.maxPositionPct },
      basedOn: f.basedOn || null,
    },
    from: f.from ? new Date(f.from).toISOString() : null,
    to: f.to ? new Date(f.to).toISOString() : null,
    replaySpeed: f.replaySpeed,
    latencyMs: f.latencyMs,
    basedOn: f.basedOn || null,
  };
}

function fromConfig(name: string, cfg: Record<string, unknown>, id: string): Form {
  const ex = (cfg.exits ?? {}) as Record<string, number>;
  const rk = (cfg.risk ?? {}) as Record<string, number>;
  return {
    ...DEFAULT_FORM,
    name: `${name} (clone)`,
    description: `Based on ${name}`,
    minNetEdge: Number(cfg.minNetEdge ?? DEFAULT_FORM.minNetEdge),
    minConfidence: Number(cfg.minConfidence ?? DEFAULT_FORM.minConfidence),
    takeProfitPp: ex.takeProfitPp ?? DEFAULT_FORM.takeProfitPp,
    stopLossPp: ex.stopLossPp ?? DEFAULT_FORM.stopLossPp,
    minDaysToResolution: ex.minDaysToResolution ?? DEFAULT_FORM.minDaysToResolution,
    kellyFraction: rk.kellyFraction ?? DEFAULT_FORM.kellyFraction,
    fixedFraction: rk.fixedFraction ?? DEFAULT_FORM.fixedFraction,
    maxPositionPct: rk.maxPositionPct ?? DEFAULT_FORM.maxPositionPct,
    headlineTrading: Boolean(cfg.headlineTrading ?? true),
    arbitrage: Boolean(cfg.arbitrage ?? true),
    basedOn: id,
  };
}

function Num({ label, k, form, set, step = 0.005 }: { label: string; k: keyof Form; form: Form; set: (f: Form) => void; step?: number }) {
  return (
    <label className="text-xs text-slate-600">
      {label}
      <input type="number" step={step} className="mt-0.5 w-full rounded border px-2 py-1 text-sm" value={form[k] as number} onChange={(e) => set({ ...form, [k]: Number(e.target.value) })} />
    </label>
  );
}

export default function Backtest() {
  const list = useApi<{ sessions: Session[]; data: { from: string | null; to: string | null; snapshots: number }; scenarioRules: Record<string, { strategy: string; trades: number }> | null }>("/api/backtests", 4000);
  const [selected, setSelected] = useState<string | null>(null);
  const [level, setLevel] = useState("");
  const detail = useApi<Detail>(selected ? `/api/backtests/${selected}${level ? `?level=${level}` : ""}` : null, 1500);
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [err, setErr] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);

  const start = async () => {
    setErr(null);
    try {
      const r = await api<{ sessionId: string }>("/api/backtests", { method: "POST", body: JSON.stringify(toRequest(form)) });
      setSelected(r.sessionId);
      list.reload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };
  const stop = async () => {
    if (!selected) return;
    await api(`/api/backtests/${selected}`, { method: "POST", body: JSON.stringify({ action: "stop" }) }).catch((e) => setErr(String(e)));
  };

  if (list.error?.includes("long-running")) return <Notice>{list.error}</Notice>;
  const d = detail.data;
  const sessions = list.data?.sessions ?? [];
  const cmp = sessions.filter((s) => compare.includes(s.session_id));

  return (
    <div className="space-y-4">
      <Card title="Backtest control" right={list.data ? <span className="text-xs text-slate-500">collected data: {fmt.t(list.data.data.from)} → {fmt.t(list.data.data.to)} ({fmt.n(list.data.data.snapshots)} snapshots)</span> : null}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
          <label className="col-span-2 text-xs text-slate-600">
            Strategy name
            <input className="mt-0.5 w-full rounded border px-2 py-1 text-sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="col-span-4 text-xs text-slate-600">
            Description (what changed)
            <input className="mt-0.5 w-full rounded border px-2 py-1 text-sm" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <Num label="Min net edge" k="minNetEdge" form={form} set={setForm} />
          <Num label="Min confidence" k="minConfidence" form={form} set={setForm} step={0.05} />
          <Num label="Take profit (pp)" k="takeProfitPp" form={form} set={setForm} />
          <Num label="Stop loss (pp)" k="stopLossPp" form={form} set={setForm} />
          <Num label="Exit days before res." k="minDaysToResolution" form={form} set={setForm} step={1} />
          <Num label="Kelly fraction" k="kellyFraction" form={form} set={setForm} step={0.05} />
          <Num label="Fixed fraction" k="fixedFraction" form={form} set={setForm} step={0.005} />
          <Num label="Max position %" k="maxPositionPct" form={form} set={setForm} step={0.01} />
          <Num label="Replay speed (0 = max)" k="replaySpeed" form={form} set={setForm} step={10} />
          <Num label="Latency ms" k="latencyMs" form={form} set={setForm} step={50} />
          <label className="text-xs text-slate-600">
            From (blank = start)
            <input type="datetime-local" className="mt-0.5 w-full rounded border px-1 py-1 text-sm" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
          </label>
          <label className="text-xs text-slate-600">
            To (blank = latest)
            <input type="datetime-local" className="mt-0.5 w-full rounded border px-1 py-1 text-sm" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={form.headlineTrading} onChange={(e) => setForm({ ...form, headlineTrading: e.target.checked })} /> headline trading
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={form.arbitrage} onChange={(e) => setForm({ ...form, arbitrage: e.target.checked })} /> arbitrage
          </label>
          <button onClick={start} disabled={Boolean(d?.running)} className="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white disabled:opacity-40">
            Start backtest
          </button>
          <button onClick={stop} disabled={!d?.running} className="rounded-lg bg-rose-600 px-4 py-2 font-medium text-white disabled:opacity-40">
            Stop backtest
          </button>
          {form.basedOn && <Badge tone="blue">based on {form.basedOn.slice(0, 8)}</Badge>}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Each run replays collected snapshots in time order (no look-ahead) and sizes every signal with all three sizing strategies in parallel portfolios, plus an
          &quot;auto&quot; portfolio that picks a strategy per scenario. A completed run updates the scenario rules used by auto sizing and live paper trading.
        </p>
        <ErrorBox error={err ?? list.error} />
      </Card>

      {d && (
        <Card
          title={`${d.strategy_name} — ${d.status}`}
          right={
            <div className="flex items-center gap-2 text-xs">
              <a className="rounded border px-2 py-0.5" href={`/api/backtests/${d.session_id}/export?kind=trades`}>trades CSV</a>
              <a className="rounded border px-2 py-0.5" href={`/api/backtests/${d.session_id}/export?kind=logs`}>logs CSV</a>
              <a className="rounded border px-2 py-0.5" href={`/api/backtests/${d.session_id}/export?kind=equity`}>equity CSV</a>
              <button className="rounded border px-2 py-0.5" onClick={() => setForm(fromConfig(d.strategy_name, d.strategy_config, d.session_id))}>
                clone &amp; modify
              </button>
            </div>
          }
        >
          {d.error && <ErrorBox error={d.error} />}
          <div className="mb-2 h-2 w-full rounded bg-slate-100">
            <div className="h-2 rounded bg-blue-600" style={{ width: `${Math.round(d.progress * 100)}%` }} />
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            <Stat label="Progress" value={fmt.pct(d.progress, 0)} sub={`sim time ${fmt.time(d.sim_time)}`} />
            <Stat label="Window" value={`${fmt.time(d.data_from)} → ${fmt.time(d.data_to)}`} />
            {Object.entries(d.equity).map(([p, pts]) => (
              <Stat key={p} label={`${p} equity`} value={fmt.n(pts[pts.length - 1]?.equity, 0)} sub={`${d.tradeCounts[p] ?? 0} fills`} />
            ))}
          </div>
          <LineChart series={Object.entries(d.equity).map(([name, pts]) => ({ name, points: pts.map((x) => ({ t: x.t, v: x.equity })) }))} baseline={100000} />

          {d.results && (
            <div className="mt-4 space-y-4">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px]">
                  <thead>
                    <tr>
                      <Th>Portfolio</Th>
                      <Th>Return</Th>
                      <Th>End capital</Th>
                      <Th>Max DD</Th>
                      <Th>Sharpe</Th>
                      <Th>Sortino</Th>
                      <Th>Win rate</Th>
                      <Th>Profit factor</Th>
                      <Th>Avg trade</Th>
                      <Th>Trades</Th>
                      <Th>Turnover</Th>
                      <Th>Max exp.</Th>
                      <Th>Utilization</Th>
                      <Th>Score</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(d.results.portfolios).map(([name, m]) => (
                      <tr key={name} className={name === d.results!.bestPortfolio ? "bg-emerald-50" : ""}>
                        <Td>
                          {name} {name === d.results!.bestPortfolio && <Badge tone="green">best</Badge>}
                        </Td>
                        <Td className={m.totalReturn >= 0 ? "text-emerald-700" : "text-rose-600"}>{fmt.pct(m.totalReturn)}</Td>
                        <Td>{fmt.n(m.endingCapital, 0)}</Td>
                        <Td>{fmt.pct(m.maxDrawdown)}</Td>
                        <Td>{fmt.p(m.sharpeRatio, 2)}</Td>
                        <Td>{fmt.p(m.sortinoRatio, 2)}</Td>
                        <Td>{fmt.pct(m.winRate, 0)}</Td>
                        <Td>{fmt.p(m.profitFactor, 2)}</Td>
                        <Td>{fmt.n(m.averageTrade, 2)}</Td>
                        <Td>
                          {m.numTrades} ({m.numClosedTrades} closed)
                        </Td>
                        <Td>{fmt.p(m.turnover, 2)}</Td>
                        <Td>{fmt.pct(m.maxExposure, 0)}</Td>
                        <Td>{fmt.pct(m.capitalUtilization, 0)}</Td>
                        <Td>{fmt.p(m.score, 3)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-500">
                Signals: {d.results.signals.decisions} decisions ({d.results.signals.rejected} rejected by risk limits), {d.results.signals.headline} headline signals,{" "}
                {d.results.signals.arbitrage} arbitrage sets over {d.results.window.ticks} ticks{d.results.window.stoppedEarly ? " (stopped early)" : ""}.
              </p>
              <div>
                <h3 className="mb-1 text-sm font-semibold">Learned sizing rules (scenario → best strategy by return on deployed capital)</h3>
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Scenario</Th>
                      <Th>Best</Th>
                      <Th>Previous rule</Th>
                      <Th>By strategy (P&L / return on capital / trades)</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(d.results.scenarioAnalysis).map(([sc, a]) => (
                      <tr key={sc}>
                        <Td className="font-mono text-xs">{sc}</Td>
                        <Td>
                          <Badge tone="green">{a.best}</Badge>
                        </Td>
                        <Td>{a.previousRule}</Td>
                        <Td className="text-xs">
                          {a.strategies.map((s) => (
                            <div key={s.strategy}>
                              {s.strategy}: {fmt.n(s.pnl, 2)} / {fmt.pct(s.returnOnCapital)} / {s.trades}
                            </div>
                          ))}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!Object.keys(d.results.scenarioAnalysis).length && <p className="text-sm text-slate-500">No trades were taken, so no scenario rules were learned.</p>}
              </div>
            </div>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-semibold">Trade feed {d.running && <Badge tone="green">live</Badge>}</h3>
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full">
                  <tbody>
                    {d.trades.slice(0, 100).map((t) => (
                      <tr key={t.id}>
                        <Td className="text-xs">{fmt.time(t.sim_ts)}</Td>
                        <Td className="text-xs">{t.portfolio}</Td>
                        <Td>
                          <ActionBadge action={t.action} />
                        </Td>
                        <Td className="text-xs">
                          #{t.market_id} {t.quantity}@{fmt.p(t.price)}
                        </Td>
                        <Td className={`text-xs ${t.realized_pnl > 0 ? "text-emerald-700" : t.realized_pnl < 0 ? "text-rose-600" : ""}`}>{t.realized_pnl ? fmt.n(t.realized_pnl, 2) : ""}</Td>
                        <Td className="text-xs text-slate-500">{t.tag}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
                Logs
                <select className="rounded border px-1 text-xs font-normal" value={level} onChange={(e) => setLevel(e.target.value)}>
                  <option value="">all</option>
                  <option>INFO</option>
                  <option>WARNING</option>
                  <option>ERROR</option>
                </select>
              </h3>
              <div className="max-h-80 overflow-y-auto font-mono text-xs">
                {d.logs.map((l) => (
                  <div key={l.id} className="border-b border-slate-100 py-0.5">
                    <span className="text-slate-400">{fmt.time(l.sim_ts)}</span>{" "}
                    <span className={l.level === "ERROR" ? "text-rose-600" : l.level === "WARNING" ? "text-amber-700" : "text-slate-600"}>{l.level}</span> {l.message}
                    {l.context?.reason ? <div className="pl-4 text-slate-400">{String(l.context.reason)}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card title="Backtest history — every strategy variant tested" right={compare.length === 2 ? <Badge tone="blue">comparing 2</Badge> : <span className="text-xs text-slate-500">tick 2 rows to compare</span>}>
        <table className="w-full">
          <thead>
            <tr>
              <Th />
              <Th>Strategy</Th>
              <Th>Status</Th>
              <Th>Window</Th>
              <Th>Best portfolio</Th>
              <Th>Best return</Th>
              <Th>Best Sharpe</Th>
              <Th>Auto return</Th>
              <Th>Started</Th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.session_id} onClick={() => setSelected(s.session_id)} className={`cursor-pointer hover:bg-slate-50 ${selected === s.session_id ? "bg-blue-50" : ""}`}>
                <Td>
                  <input
                    type="checkbox"
                    checked={compare.includes(s.session_id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setCompare(e.target.checked ? [...compare, s.session_id].slice(-2) : compare.filter((x) => x !== s.session_id))}
                  />
                </Td>
                <Td>
                  <div className="font-medium">{s.strategy_name}</div>
                  <div className="text-xs text-slate-500">{s.description}</div>
                </Td>
                <Td>
                  <Badge tone={s.status === "completed" ? "green" : s.status === "running" ? "blue" : s.status === "failed" ? "red" : "slate"}>{s.status}</Badge>{" "}
                  {s.status === "running" && fmt.pct(s.progress, 0)}
                </Td>
                <Td className="text-xs">
                  {fmt.time(s.data_from)} → {fmt.time(s.data_to)}
                </Td>
                <Td>{s.bestPortfolio ?? "–"}</Td>
                <Td>{fmt.pct(s.best?.totalReturn)}</Td>
                <Td>{fmt.p(s.best?.sharpeRatio, 2)}</Td>
                <Td>{fmt.pct(s.auto?.totalReturn)}</Td>
                <Td className="text-xs">{fmt.t(s.started_at)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        {cmp.length === 2 && (
          <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
            <b>{cmp[0].strategy_name}</b> vs <b>{cmp[1].strategy_name}</b> (auto portfolios): return {fmt.pct(cmp[0].auto?.totalReturn)} vs {fmt.pct(cmp[1].auto?.totalReturn)}; Sharpe{" "}
            {fmt.p(cmp[0].auto?.sharpeRatio, 2)} vs {fmt.p(cmp[1].auto?.sharpeRatio, 2)}; max DD {fmt.pct(cmp[0].auto?.maxDrawdown)} vs {fmt.pct(cmp[1].auto?.maxDrawdown)}; win rate{" "}
            {fmt.pct(cmp[0].auto?.winRate, 0)} vs {fmt.pct(cmp[1].auto?.winRate, 0)}.{" "}
            {cmp[0].auto && cmp[1].auto && (
              <span className="font-medium">
                → {(cmp[0].auto.score ?? 0) >= (cmp[1].auto.score ?? 0) ? cmp[0].strategy_name : cmp[1].strategy_name} scores higher.
              </span>
            )}
          </div>
        )}
        {list.data?.scenarioRules && (
          <p className="mt-3 text-xs text-slate-500">
            Active auto-sizing rules: {Object.entries(list.data.scenarioRules).map(([k, v]) => `${k} → ${v.strategy} (${v.trades})`).join("; ")}
          </p>
        )}
      </Card>
    </div>
  );
}
