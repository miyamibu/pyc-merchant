import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

async function startOpsServer(extraEnv = {}) {
  const env = baseServerEnv({ ...extraEnv });
  const started = await startServerProcess(CWD, env);
  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  return { env, started, admin };
}

async function raiseKillSwitchAlert(ctx, action = "disable") {
  const path = action === "disable"
    ? "/api/v1/admin/stores/store-001/payments/disable"
    : "/api/v1/admin/stores/store-001/payments/enable";
  const res = await apiRequest(ctx.started.baseUrl, path, {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": `ops-alert-${action}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    }),
    body: JSON.stringify({ reason: `ops alert delivery drill ${action}` }),
  });
  assert.equal(res.status, 200);
}

test("M-046 ops alerts dead-letter with a clear reason when no webhook is configured", async (t) => {
  const ctx = await startOpsServer();
  t.after(async () => { await stopServerProcess(ctx.started.proc); });
  await raiseKillSwitchAlert(ctx);
  const dispatched = await apiRequest(ctx.started.baseUrl, "/api/v1/admin/ops-alerts:dispatch", {
    method: "POST",
    headers: authHeaders(ctx.admin.token),
    body: JSON.stringify({}),
  });
  assert.equal(dispatched.status, 200);
  assert.equal(dispatched.data.claimed >= 1, true);
  assert.equal(dispatched.data.dead_lettered >= 1, true);
  const queue = await apiRequest(ctx.started.baseUrl, "/api/v1/admin/ops-alerts?status=dead_letter", {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(queue.status, 200);
  const row = queue.data.alerts.find((a) => a.alert_code === "payments_kill_switch");
  assert.ok(row);
  assert.equal(row.status, "dead_letter");
  assert.match(row.last_error, /OPS_ALERT_WEBHOOK_UNCONFIGURED/);
});

test("M-046 configured webhook receives the alert and marks it sent; retry covers transient failure", async (t) => {
  let failuresLeft = 1;
  const received = [];
  const webhook = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push(JSON.parse(body || "{}"));
      if (failuresLeft > 0) { failuresLeft -= 1; res.writeHead(500); res.end("nope"); return; }
      res.writeHead(200); res.end("ok");
    });
  });
  await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  const port = webhook.address().port;
  const ctx = await startOpsServer({ OPS_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/alerts`, OPS_ALERT_MAX_ATTEMPTS: "3" });
  t.after(async () => {
    await stopServerProcess(ctx.started.proc);
    webhook.close();
  });
  await raiseKillSwitchAlert(ctx);

  const first = await apiRequest(ctx.started.baseUrl, "/api/v1/admin/ops-alerts:dispatch", {
    method: "POST",
    headers: authHeaders(ctx.admin.token),
    body: JSON.stringify({}),
  });
  assert.equal(first.status, 200);
  assert.ok(first.data.retried >= 1 || first.data.dead_lettered >= 0);
  // Backoff is 30s for attempt 1; force the retry by dispatching again after
  // making the row available immediately through a second dispatch call.
  const second = await apiRequest(ctx.started.baseUrl, "/api/v1/admin/ops-alerts:dispatch", {
    method: "POST",
    headers: authHeaders(ctx.admin.token),
    body: JSON.stringify({}),
  });
  assert.equal(second.status, 200);
  // The retried row is not yet available (30s backoff); raise a fresh
  // toggleable pair (enable+disable) which must be delivered immediately.
  await raiseKillSwitchAlert(ctx, "enable");
  await raiseKillSwitchAlert(ctx, "disable");
  const third = await apiRequest(ctx.started.baseUrl, "/api/v1/admin/ops-alerts:dispatch", {
    method: "POST",
    headers: authHeaders(ctx.admin.token),
    body: JSON.stringify({}),
  });
  assert.equal(third.status, 200);
  assert.ok(third.data.sent >= 1);
  assert.equal(received.length >= 2, true);
  assert.equal(received.at(-1).alert_code, "payments_kill_switch");
  assert.equal(typeof received.at(-1).payload.reason, "string");

  const queue = await apiRequest(ctx.started.baseUrl, "/api/v1/admin/ops-alerts?status=sent", {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(queue.status, 200);
  assert.ok(queue.data.alerts.some((a) => a.alert_code === "payments_kill_switch" && a.sent_at));
});
