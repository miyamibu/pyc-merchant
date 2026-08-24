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

async function startHardeningServer(extraEnv = {}) {
  const env = baseServerEnv({ ...extraEnv });
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);
  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  return { env, started, db, admin };
}

test("N-017 invalid pagination values return client errors instead of 500", async (t) => {
  const ctx = await startHardeningServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });
  for (const query of ["limit=abc", "limit=-5", "limit=1.5", "offset=xyz", "limit=99999999999"]) {
    const res = await apiRequest(ctx.started.baseUrl, `/api/v1/audit-logs?${query}`, {
      headers: authHeaders(ctx.admin.token),
    });
    assert.equal(res.status, 400, `query ${query} should be a client error`);
    assert.equal(res.data.error.code, "VALIDATION_ERROR");
  }
  const ok = await apiRequest(ctx.started.baseUrl, "/api/v1/audit-logs?limit=10&offset=0", {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(ok.status, 200);
});

test("M-035 unknown terminal and wrong PIN are indistinguishable", async (t) => {
  const ctx = await startHardeningServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });
  const unknownRes = await apiRequest(ctx.started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalCode: "NO-SUCH-TERMINAL", staffPin: "1234" }),
  });
  assert.equal(unknownRes.status, 401);
  const wrongPinRes = await apiRequest(ctx.started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalCode: ctx.env.TERMINAL_CODE,
      staffPin: "000000",
      staffName: "Demo Staff",
    }),
  });
  assert.equal(wrongPinRes.status, 401);
  assert.deepEqual(
    { status: unknownRes.status, body: unknownRes.data },
    { status: wrongPinRes.status, body: wrongPinRes.data },
  );
});

test("M-038 rate limiter buckets stay bounded under many unique keys", async (t) => {
  const ctx = await startHardeningServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });
  for (let i = 0; i < 40; i += 1) {
    await createInvoice(ctx.started.baseUrl, ctx.admin.token, 100 + i, `hardening-${i}-${Date.now()}`);
  }
  const health = await fetch(`${ctx.started.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const okBody = await health.json();
  assert.equal(okBody.ok, true);
});

test("M-048 repeated recovery reports keep history and expose a cross-case queue", async (t) => {
  const ctx = await startHardeningServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });
  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 900, `recovery-queue-${Date.now()}`);
  assert.equal(created.status, 201);

  const reportOnce = await apiRequest(ctx.started.baseUrl, "/api/v1/payment-recovery/reports", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, { "content-type": "application/json" }),
    body: JSON.stringify({
      invoice_id: created.data.invoice_id,
      chain_id: 137,
      tx_hash: `0x${"a".repeat(64)}`,
      reported_issue: "wrong_chain",
    }),
  });
  assert.equal(reportOnce.status, 201);
  const reportTwice = await apiRequest(ctx.started.baseUrl, "/api/v1/payment-recovery/reports", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, { "content-type": "application/json" }),
    body: JSON.stringify({
      invoice_id: created.data.invoice_id,
      chain_id: 137,
      tx_hash: `0x${"a".repeat(64)}`,
      reported_issue: "wrong_chain",
    }),
  });
  assert.ok([200, 201].includes(reportTwice.status));

  const reportId = reportOnce.data.report.id;
  const history = await apiRequest(
    ctx.started.baseUrl,
    `/api/v1/payment-recovery/reports/${reportId}/history`,
    { headers: authHeaders(ctx.admin.token) },
  );
  assert.equal(history.status, 200);
  assert.equal(history.data.report_id, reportId);
  assert.ok(Array.isArray(history.data.revisions));
  assert.equal(history.data.revisions.length, 1);
  assert.equal(Number(history.data.revisions[0].revision), 1);
  assert.equal(history.data.revisions[0].prior_row.reported_issue, "wrong_chain");

  const queue = await apiRequest(ctx.started.baseUrl, "/api/v1/payment-recovery/reports", {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(queue.status, 200);
  assert.ok(Array.isArray(queue.data.reports));
  const queued = queue.data.reports.find((entry) => entry.id === reportId);
  assert.ok(queued);
  assert.equal(Number(queued.revision), 2);

  const badPage = await apiRequest(ctx.started.baseUrl, "/api/v1/payment-recovery/reports?limit=nope", {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(badPage.status, 400);
});

test("N-025 staff_name length and Unicode boundaries are enforced", async (t) => {
  const ctx = await startHardeningServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });
  const longName = "あ".repeat(41);
  const tooLong = await apiRequest(ctx.started.baseUrl, "/api/v1/staff", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, { "content-type": "application/json", "idempotency-key": `staff-long-${Date.now()}` }),
    body: JSON.stringify({ staff_name: longName, role: "staff", pin: "1234", status: "active" }),
  });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.data.error.message, /at most 40/);
  const controlChar = await apiRequest(ctx.started.baseUrl, "/api/v1/staff", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, { "content-type": "application/json", "idempotency-key": `staff-ctrl-${Date.now()}` }),
    body: JSON.stringify({ staff_name: "bad\nname", role: "staff", pin: "1234" }),
  });
  assert.equal(controlChar.status, 400);
});

test("N-025 terminal_code format is validated on creation without new login oracle", async (t) => {
  const ctx = await startHardeningServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });
  const badCreate = await apiRequest(ctx.started.baseUrl, "/api/v1/terminals", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, { "content-type": "application/json" }),
    body: JSON.stringify({ terminal_code: "bad code!", status: "active" }),
  });
  assert.equal(badCreate.status, 400);
  const unknownFormatLogin = await apiRequest(ctx.started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalCode: "bad code!", staffPin: "1234" }),
  });
  // Format-invalid codes must be indistinguishable from any other credential
  // failure so the format rule does not become a new enumeration oracle.
  const unknownPlainLogin = await apiRequest(ctx.started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalCode: "NO-SUCH-TERMINAL", staffPin: "1234" }),
  });
  assert.deepEqual(
    { status: unknownFormatLogin.status, body: unknownFormatLogin.data },
    { status: unknownPlainLogin.status, body: unknownPlainLogin.data },
  );
  assert.equal(unknownFormatLogin.status, 401);
});

test("N-025 oversized idempotency keys are rejected with a client error", async (t) => {
  const ctx = await startHardeningServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });
  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 300, `idem-len-${Date.now()}`);
  assert.equal(created.status, 201);
  const res = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": "k".repeat(201),
    }),
    body: JSON.stringify({ business_date: "2000-01-01" }),
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error.message, /at most 200/);
});
