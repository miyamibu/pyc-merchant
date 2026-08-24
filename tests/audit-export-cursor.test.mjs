import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

async function startCursorServer() {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);
  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  return { env, started, db, admin };
}

test("M-032 audit export follows cursors to a complete, duplicate-free result", async (t) => {
  const ctx = await startCursorServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  // Generate enough auditable activity to span several pages. Address-pool
  // imports are audited and repeatable without touching terminal state.
  const { randomBytes } = await import("node:crypto");
  for (let batch = 0; batch < 8; batch += 1) {
    const addresses = Array.from({ length: 4 }, () => `0x${randomBytes(20).toString("hex")}`);
    const imported = await apiRequest(ctx.started.baseUrl, "/api/v1/admin/receive-addresses:import", {
      method: "POST",
      headers: authHeaders(ctx.admin.token, {
        "content-type": "application/json",
        "idempotency-key": `cursor-batch-${batch}-${Date.now()}-${randomBytes(4).toString("hex")}`,
      }),
      body: JSON.stringify({ source_label: `cursor_batch_${batch}_${Date.now()}`, addresses }),
    });
    if (imported.status !== 201) {
      console.error("import failed:", imported.status, JSON.stringify(imported.data));
    }
    assert.equal(imported.status, 201);
  }

  const listed = await apiRequest(ctx.started.baseUrl, "/api/v1/audit-logs?limit=1", {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(listed.status, 200);

  const seen = new Set();
  let cursor = "";
  let pages = 0;
  let firstMeta = null;
  while (pages < 200) {
    const query = new URLSearchParams({ limit: "5", format: "json" });
    if (cursor) query.set("cursor", cursor);
    const res = await apiRequest(ctx.started.baseUrl, `/api/v1/audit-logs/export?${query.toString()}`, {
      headers: authHeaders(ctx.admin.token),
    });
    assert.equal(res.status, 200);
    if (!firstMeta) {
      firstMeta = res.data.meta;
      assert.ok(firstMeta.total_count >= 8);
    }
    for (const row of res.data.audit_logs) {
      assert.ok(!seen.has(row.id), `duplicate row ${row.id} across export pages`);
      seen.add(row.id);
    }
    if (!res.data.meta.has_more) break;
    assert.ok(res.data.meta.next_cursor);
    cursor = res.data.meta.next_cursor;
    pages += 1;
  }
  assert.equal(seen.size, firstMeta.total_count);
  assert.ok(pages >= 1);
});

test("M-032 invalid cursor is a client error", async (t) => {
  const ctx = await startCursorServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });
  const res = await apiRequest(ctx.started.baseUrl, "/api/v1/audit-logs/export?cursor=%%%invalid", {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "VALIDATION_ERROR");
});
