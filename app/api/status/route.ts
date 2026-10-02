import { config, statefulMode } from "@/lib/server/config";
import { ok } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const mode = statefulMode();
  let collector = null;
  let data = null;
  if (mode === "local") {
    const { collector: c } = await import("@/lib/server/collector");
    const { dataRange } = await import("@/lib/server/store");
    collector = c().status();
    data = dataRange();
  }
  return ok({
    statefulMode: mode,
    hasApiKey: Boolean(config.sigApiKey),
    tournament: config.tournamentSlug,
    rateLimits: { readsPerMinute: config.readsPerMinute, safety: config.rateSafety, source: "Super Market API reference: standard keys 100 reads per minute; 429 Retry-After 60. Read-only: no order writes are ever sent." },
    polling: { priceIntervalSec: config.priceIntervalSec, externalIntervalSec: config.externalIntervalSec, newsMarketsPerMinute: config.newsMarketsPerMinute },
    executionMode: "paper",
    adminTokenRequired: Boolean(config.adminToken),
    collector,
    data,
  });
}
