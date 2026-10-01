// Resume data collection after a server restart if it was running (long-running hosts only).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { statefulMode } = await import("./lib/server/config");
  if (statefulMode() !== "local" || process.env.NODE_ENV === "test" || process.env.COLLECTOR_AUTORESUME === "0") return;
  try {
    const { kvGet } = await import("./lib/server/db");
    const want = kvGet<{ running?: boolean; paperTrading?: boolean; strategy?: Record<string, unknown> } | null>("collector_desired", null);
    if (want?.running) {
      const { collector } = await import("./lib/server/collector");
      await collector().start({ paperTrading: want.paperTrading, strategy: want.strategy });
    }
  } catch (e) {
    console.error(JSON.stringify({ level: "ERROR", component: "instrumentation", event: "resume_failed", error: String(e) }));
  }
}
