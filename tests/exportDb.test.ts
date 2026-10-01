import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setDb, db } from "@/lib/server/db";
import { GET } from "@/app/api/export/db/route";

describe("database export endpoint", () => {
  const file = path.join(os.tmpdir(), `export-test-${Date.now()}.db`);
  beforeAll(() => {
    setDb(openDb(file));
    db().prepare("INSERT INTO kv(k, v, updated_at) VALUES ('probe', '1', 'now')").run();
  });
  afterAll(() => {
    setDb(null);
    delete process.env.BOT_EXPORT_TOKEN;
    fs.rmSync(file, { force: true });
  });
  const call = (token?: string) => GET(new Request("http://x/api/export/db", { headers: token ? { "x-export-token": token } : {} }));

  it("is disabled without BOT_EXPORT_TOKEN and rejects bad tokens", async () => {
    delete process.env.BOT_EXPORT_TOKEN;
    expect((await call("anything")).status).toBe(404);
    process.env.BOT_EXPORT_TOKEN = "s3cret-token";
    expect((await call()).status).toBe(403);
    expect((await call("wrong")).status).toBe(403);
  });

  it("returns a gzipped, readable copy of the database", async () => {
    process.env.BOT_EXPORT_TOKEN = "s3cret-token";
    const res = await call("s3cret-token");
    expect(res.status).toBe(200);
    const raw = gunzipSync(Buffer.from(await res.arrayBuffer()));
    expect(raw.subarray(0, 15).toString()).toBe("SQLite format 3");
    const copy = path.join(os.tmpdir(), `export-copy-${Date.now()}.db`);
    fs.writeFileSync(copy, raw);
    const d = openDb(copy);
    expect(d.prepare("SELECT v FROM kv WHERE k='probe'").get()?.v).toBe("1");
    fs.rmSync(copy, { force: true });
  });
});
