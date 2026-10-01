import { timingSafeEqual } from "node:crypto";
import { config, statefulMode } from "@/lib/server/config";

export const dynamic = "force-dynamic";

let busy = false;

function tokenOk(given: string | null): boolean {
  const want = config.exportToken;
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Read-only download of the collected database (gzipped SQLite snapshot) for offline backtesting.
 * Disabled unless BOT_EXPORT_TOKEN is set; requires `x-export-token`. This token grants no other
 * access: it cannot start/stop the collector, trade, or reset anything.
 */
export async function GET(req: Request) {
  if (!config.exportToken) return Response.json({ error: { code: "DISABLED", message: "Set BOT_EXPORT_TOKEN to enable database export" } }, { status: 404 });
  if (!tokenOk(req.headers.get("x-export-token"))) return Response.json({ error: { code: "FORBIDDEN", message: "Missing or invalid x-export-token" } }, { status: 403 });
  if (statefulMode() !== "local") return Response.json({ error: { code: "UNAVAILABLE", message: "Export runs on the bot backend only" } }, { status: 503 });
  if (busy) return Response.json({ error: { code: "BUSY", message: "An export is already running" } }, { status: 429 });
  busy = true;
  try {
    const { snapshotDb } = await import("@/lib/server/exportDb");
    const { gz, bytes } = snapshotDb();
    return new Response(new Uint8Array(gz), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="predictioncup-${new Date().toISOString().replace(/[:.]/g, "-")}.db.gz"`,
        "x-db-bytes": String(bytes),
        "cache-control": "no-store",
      },
    });
  } finally {
    busy = false;
  }
}
