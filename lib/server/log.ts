// Structured JSON logging to stdout. Persistent logs go through the store (see db.ts).

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const order: Record<Level, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };
const min = (process.env.LOG_LEVEL?.toUpperCase() as Level) || "INFO";

type Sink = (entry: { ts: string; level: Level; component: string; event: string; [k: string]: unknown }) => void;
const sinks: Sink[] = [];

export function addLogSink(s: Sink) {
  sinks.push(s);
  return () => {
    const i = sinks.indexOf(s);
    if (i >= 0) sinks.splice(i, 1);
  };
}

export function log(level: Level, component: string, event: string, fields: Record<string, unknown> = {}) {
  if (order[level] < (order[min] ?? 20)) return;
  const entry = { ts: new Date().toISOString(), level, component, event, ...fields };
  if (process.env.NODE_ENV !== "test") console.log(JSON.stringify(entry));
  for (const s of sinks) {
    try {
      s(entry);
    } catch {
      /* never let logging break the bot */
    }
  }
}
