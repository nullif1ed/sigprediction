import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { db } from "./db";

/**
 * Consistent copy of the live database (VACUUM INTO works while the collector keeps writing),
 * gzipped. The temporary file is always removed.
 */
export function snapshotDb(): { gz: Buffer; bytes: number } {
  const tmp = path.join(os.tmpdir(), `pc-export-${process.pid}-${Date.now()}.db`);
  try {
    db().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const raw = fs.readFileSync(tmp);
    return { gz: gzipSync(raw, { level: 6 }), bytes: raw.length };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
