import test from "node:test";
import assert from "node:assert/strict";

import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  loginAs,
  parsePaymentUrl,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

test("customer and staff recovery reports remain read-only and distinguish unverified reports", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(process.cwd(), env);
  t.after(async () => stopServerProcess(started.proc));

  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const created = await createInvoice(started.baseUrl, staff.token, 1000, `recovery-invoice-${Date.now()}`);
  assert.equal(created.status, 201);
  const paymentRef = parsePaymentUrl(created.data.payment_url);
  const authenticatedInvoice = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}`,
    { headers: authHeaders(staff.token) },
  );
  assert.equal(authenticatedInvoice.status, 200);
  assert.deepEqual(authenticatedInvoice.data.payment_recovery_chains, []);
  const publicInvoicePath = `/api/v1/public/invoices/${encodeURIComponent(created.data.invoice_id)}`
    + `?sig=${encodeURIComponent(paymentRef.sig)}&exp=${encodeURIComponent(paymentRef.exp)}&nonce=${encodeURIComponent(paymentRef.nonce)}`;
  const publicInvoice = await apiRequest(started.baseUrl, publicInvoicePath);
  assert.equal(publicInvoice.status, 200);
  assert.deepEqual(publicInvoice.data.payment_recovery_chains, []);
  const publicPath = `/api/v1/public/invoices/${created.data.invoice_id}/payment-recovery?sig=${encodeURIComponent(paymentRef.sig)}&exp=${encodeURIComponent(paymentRef.exp)}&nonce=${encodeURIComponent(paymentRef.nonce)}`;

  const customer = await apiRequest(
    started.baseUrl,
    publicPath,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain_id: "1",
        tx_hash: randomTxHash("customer-recovery"),
        reported_issue: "wrong_chain",
      }),
    },
  );
  assert.equal(customer.status, 201);
  assert.equal(customer.data.status, "customer_reported_wrong_chain");
  assert.equal(customer.data.verification.rpc_verified, false);

  const staffReport = await apiRequest(started.baseUrl, "/api/v1/payment-recovery/reports", {
    method: "POST",
    headers: authHeaders(staff.token, { "content-type": "application/json" }),
    body: JSON.stringify({
      invoice_id: created.data.invoice_id,
      chain_id: "43114",
      tx_hash: randomTxHash("staff-recovery"),
      reported_issue: "wrong_token",
    }),
  });
  assert.equal(staffReport.status, 201);
  assert.equal(staffReport.data.status, "unverified_report");
});

test("invoice payloads publish only configured official Polygon recovery metadata and never RPC URLs", async (t) => {
  const privateRpcFixture = "http://127.0.0.1:18545/private-rpc?access=test-fixture";
  const env = baseServerEnv({ RPC_URLS_137: privateRpcFixture });
  const started = await startServerProcess(process.cwd(), env);
  t.after(async () => stopServerProcess(started.proc));

  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const created = await createInvoice(
    started.baseUrl,
    staff.token,
    1370,
    `recovery-polygon-payload-${Date.now()}`,
  );
  assert.equal(created.status, 201);
  const paymentRef = parsePaymentUrl(created.data.payment_url);
  const publicPath = `/api/v1/public/invoices/${encodeURIComponent(created.data.invoice_id)}`
    + `?sig=${encodeURIComponent(paymentRef.sig)}&exp=${encodeURIComponent(paymentRef.exp)}&nonce=${encodeURIComponent(paymentRef.nonce)}`;
  const [authenticatedInvoice, publicInvoice] = await Promise.all([
    apiRequest(
      started.baseUrl,
      `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}`,
      { headers: authHeaders(staff.token) },
    ),
    apiRequest(started.baseUrl, publicPath),
  ]);
  assert.equal(authenticatedInvoice.status, 200);
  assert.equal(publicInvoice.status, 200);

  for (const payload of [authenticatedInvoice.data, publicInvoice.data]) {
    assert.deepEqual(payload.payment_recovery_chains, [{
      chain_id: "137",
      network: "Polygon",
      short_name: "Polygon",
      native_symbol: "POL",
      token_symbol: "JPYC",
      official_token_contract: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", // gitleaks:allow — public contract address fixture
    }]);
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /18545|private-rpc|access=test-fixture/i);
  }
});
