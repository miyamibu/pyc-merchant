import test from "node:test";
import assert from "node:assert/strict";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("commercial mode blocks invoice issuance but keeps read-only ops endpoints", async (t) => {
  const env = baseServerEnv({
    COMMERCIAL_GO_MODE: "true",
    SETTLEMENT_UNRESOLVED_REVIEW_POLICY: "block",
  });
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });

  const blockedInvoice = await apiRequest(started.baseUrl, "/api/v1/invoices", {
    method: "POST",
    headers: authHeaders(admin.token, {
      "content-type": "application/json",
      "idempotency-key": `commercial-block-${Date.now()}`,
    }),
    body: JSON.stringify({ amount_jpy: 1000, payment_chain_id: "137" }),
  });
  assert.equal(blockedInvoice.status, 503);
  assert.equal(blockedInvoice.data.error.code, "COMMERCIAL_GATE_BLOCKED");
  assert.ok(Array.isArray(blockedInvoice.data.error.details.blockers));

  const auditRead = await apiRequest(started.baseUrl, "/api/v1/audit-logs?limit=20", {
    headers: authHeaders(admin.token),
  });
  assert.equal(auditRead.status, 200);

  const settlementStatus = await apiRequest(started.baseUrl, "/api/v1/settlements/daily-status?business_date=2026-04-22", {
    headers: authHeaders(admin.token),
  });
  assert.equal(settlementStatus.status, 200);

  const health = await apiRequest(started.baseUrl, "/healthz");
  assert.equal(health.status, 200);
});
