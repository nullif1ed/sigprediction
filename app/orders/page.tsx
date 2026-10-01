"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionBadge, Badge, Card, ErrorBox, fmt, Td, Th, useApi } from "@/components/ui";

interface Order {
  order_id: string;
  market_id: string;
  title: string;
  action: string;
  order_type: string;
  requested_quantity: number;
  filled_quantity: number;
  fill_price: number | null;
  fees: number;
  status: string;
  created_at: string;
  notes: string | null;
  tag: string | null;
}
interface FillRow {
  id: number;
  order_id: string;
  market_id: string;
  action: string;
  quantity: number;
  price: number;
  yes_price: number;
  realized_pnl: number;
  ts: string;
}

export default function Orders() {
  const [status, setStatus] = useState("");
  const [action, setAction] = useState("");
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (action) q.set("action", action);
  const { data, error } = useApi<{ orders: Order[]; fills: FillRow[] }>(`/api/paper?${q}`, 5000);
  const pnlByOrder = new Map<string, number>();
  for (const f of data?.fills ?? []) pnlByOrder.set(f.order_id, (pnlByOrder.get(f.order_id) ?? 0) + f.realized_pnl);

  const csv = () => {
    const rows = data?.orders ?? [];
    const cols = ["created_at", "order_id", "market_id", "title", "action", "order_type", "requested_quantity", "filled_quantity", "fill_price", "fees", "status", "tag", "notes"] as const;
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const text = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = "paper-orders.csv";
    a.click();
  };

  return (
    <Card
      title="Paper trade log (every simulated order)"
      right={
        <div className="flex items-center gap-2 text-sm">
          <select className="rounded border px-1" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all statuses</option>
            {["filled", "partially_filled", "pending", "cancelled", "expired", "rejected"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select className="rounded border px-1" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">all actions</option>
            {["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button onClick={csv} className="rounded border px-2 py-0.5">
            Export CSV
          </button>
        </div>
      }
    >
      <ErrorBox error={error} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px]">
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Market</Th>
              <Th>Action</Th>
              <Th>Type</Th>
              <Th>Filled / requested</Th>
              <Th>Fill price</Th>
              <Th>Fees</Th>
              <Th>Realized P&L</Th>
              <Th>Status</Th>
              <Th>Reason / tag</Th>
            </tr>
          </thead>
          <tbody>
            {(data?.orders ?? []).map((o) => {
              const pnl = pnlByOrder.get(o.order_id);
              return (
                <tr key={o.order_id}>
                  <Td>{fmt.t(o.created_at)}</Td>
                  <Td>
                    <Link className="text-blue-700" href={`/markets/${o.market_id}`}>
                      {o.title}
                    </Link>
                  </Td>
                  <Td>
                    <ActionBadge action={o.action} />
                  </Td>
                  <Td>{o.order_type}</Td>
                  <Td>
                    {o.filled_quantity} / {o.requested_quantity}
                  </Td>
                  <Td>{fmt.p(o.fill_price)}</Td>
                  <Td>{fmt.p(o.fees, 2)}</Td>
                  <Td className={pnl ? (pnl > 0 ? "text-emerald-700" : "text-rose-600") : ""}>{pnl ? fmt.n(pnl, 2) : "–"}</Td>
                  <Td>
                    <Badge tone={o.status === "filled" ? "green" : o.status === "partially_filled" ? "amber" : "slate"}>{o.status}</Badge>
                  </Td>
                  <Td className="text-xs text-slate-500">
                    {o.tag}
                    {o.notes ? ` · ${o.notes}` : ""}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && !data.orders.length && <p className="text-sm text-slate-500">No paper orders yet. Start collection with paper trading enabled on the dashboard.</p>}
    </Card>
  );
}
