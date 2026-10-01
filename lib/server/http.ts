import { config, statefulMode } from "./config";
import { SigApiError } from "./sigClient";

export function ok(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export function fail(e: unknown, status = 500) {
  if (e instanceof SigApiError) {
    return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status >= 400 ? e.status : 502 });
  }
  return Response.json({ error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) } }, { status });
}

/**
 * Stateful endpoints (collector, paper trading, backtests) need a long-running process.
 * On Vercel they are proxied to BOT_BACKEND_URL, or reported unavailable.
 */
export async function statefulGuard(req: Request): Promise<Response | null> {
  const mode = statefulMode();
  if (mode === "local") return null;
  if (mode === "proxy") {
    const u = new URL(req.url);
    const target = `${config.backendUrl}${u.pathname}${u.search}`;
    const headers: Record<string, string> = { "content-type": req.headers.get("content-type") ?? "application/json" };
    const tok = req.headers.get("x-bot-token");
    if (tok) headers["x-bot-token"] = tok;
    try {
      const res = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
        cache: "no-store",
      });
      return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
    } catch (e) {
      return Response.json({ error: { code: "BACKEND_UNREACHABLE", message: `Bot backend ${config.backendUrl} unreachable: ${String(e)}` } }, { status: 502 });
    }
  }
  return Response.json(
    {
      error: {
        code: "STATEFUL_UNAVAILABLE",
        message:
          "Data collection, paper trading and backtests need a long-running process with a disk. Run the app locally (npm run build && npm start) or on a VPS, then set BOT_BACKEND_URL on Vercel to proxy to it.",
      },
    },
    { status: 503 },
  );
}

/** Mutating endpoints require x-bot-token when BOT_ADMIN_TOKEN is configured. */
export function adminGuard(req: Request): Response | null {
  if (!config.adminToken) return null;
  if (req.headers.get("x-bot-token") === config.adminToken) return null;
  return Response.json({ error: { code: "FORBIDDEN", message: "Missing or invalid x-bot-token" } }, { status: 403 });
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
