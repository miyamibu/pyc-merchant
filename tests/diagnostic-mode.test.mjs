import test from "node:test";
import assert from "node:assert/strict";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("SR-16 diagnostic mode is env-gated and exposes read-only invoice diagnostics with reissue lineage", async (t) => {
  const env = baseServerEnv({
    DIAGNOSTIC_MODE_ENABLED: "true",
    MAX_ACTIVE_INVOICES_PER_RECIPIENT: "2",
  });
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });

  const importRes = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
    method: "POST",
    headers: authHeaders(admin.token, {
      "content-type": "application/json",
      "idempotency-key": `diag-import-${Date.now()}`,
    }),
    body: JSON.stringify({
      source_label: "diag-seed",
      addresses: [
        "0x3000000000000000000000000000000000000001",
        "0x3000000000000000000000000000000000000002",
      ],
    }),
  });
  assert.equal(importRes.status, 201);

  const created = await createInvoice(started.baseUrl, admin.token, 1250, `diag-invoice-${Date.now()}`);
  assert.equal(created.status, 201);

  const originalDetail = await getInvoice(started.baseUrl, admin.token, created.data.invoice_id);
  assert.equal(originalDetail.status, 200);
  assert.ok(originalDetail.data.diagnostics);
  assert.equal(originalDetail.data.diagnostics.wallet_adapter.status, "mock_only");
  assert.equal(originalDetail.data.diagnostics.invoice_status, "issued");
  assert.equal(originalDetail.data.diagnostics.pay_url, originalDetail.data.pay_url);
  assert.equal(originalDetail.data.diagnostics.receive_address, originalDetail.data.chain.recipient_address);
  assert.ok(Array.isArray(originalDetail.data.diagnostics.supported_wallets));
  assert.ok(originalDetail.data.diagnostics.supported_wallets.length >= 1);
  assert.equal(originalDetail.data.diagnostics.reissue.root_invoice_id, created.data.invoice_id);
  assert.equal(originalDetail.data.diagnostics.reissue.latest_invoice_id, created.data.invoice_id);

  const reissued = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}/reissue`,
    {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `diag-reissue-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(reissued.status, 201);

  const oldDetail = await getInvoice(started.baseUrl, admin.token, created.data.invoice_id);
  const newDetail = await getInvoice(started.baseUrl, admin.token, reissued.data.invoice_id);
  assert.equal(oldDetail.status, 200);
  assert.equal(newDetail.status, 200);

  assert.equal(oldDetail.data.status, "expired");
  assert.equal(newDetail.data.status, "issued");
  assert.notEqual(oldDetail.data.payment_url, newDetail.data.payment_url);
  assert.equal(oldDetail.data.diagnostics.reissue.root_invoice_id, created.data.invoice_id);
  assert.equal(oldDetail.data.diagnostics.reissue.latest_invoice_id, reissued.data.invoice_id);
  assert.equal(newDetail.data.diagnostics.reissue.root_invoice_id, created.data.invoice_id);
  assert.equal(newDetail.data.diagnostics.reissue.latest_invoice_id, reissued.data.invoice_id);
  assert.equal(newDetail.data.diagnostics.reissue.total_versions, 2);
  assert.deepEqual(
    newDetail.data.diagnostics.reissue.history.map((row) => row.invoice_id),
    [reissued.data.invoice_id, created.data.invoice_id]
  );
});

test("SR-16 diagnostic mode stays hidden when env flag is off", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const login = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalCode: env.TERMINAL_CODE,
      staffPin: env.STAFF_PIN,
    }),
  });
  assert.equal(login.status, 201);
  assert.equal(login.data.diagnostic_mode_enabled, false);

  const created = await createInvoice(started.baseUrl, login.data.token, 980, `diag-off-${Date.now()}`);
  assert.equal(created.status, 201);

  const detail = await getInvoice(started.baseUrl, login.data.token, created.data.invoice_id);
  assert.equal(detail.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(detail.data, "diagnostics"), false);
});
