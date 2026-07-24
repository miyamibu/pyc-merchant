import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  ingestManualPayment,
  loginAs,
  parsePaymentUrl,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("receive address reissue keeps old QR on late-arrival review path and scoped kill switches block new invoices", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);

  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });

  const globalDisableDenied = await apiRequest(started.baseUrl, "/api/v1/admin/payments/disable", {
    method: "POST",
    headers: authHeaders(admin.token, {
      "content-type": "application/json",
      "idempotency-key": `global-disable-denied-${Date.now()}`,
    }),
    body: JSON.stringify({ reason: "store_admin_must_not_control_global" }),
  });
  assert.equal(globalDisableDenied.status, 403);

  const importRes = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
    method: "POST",
    headers: authHeaders(admin.token, {
      "content-type": "application/json",
      "idempotency-key": `pool-hardening-${Date.now()}`,
    }),
    body: JSON.stringify({
      source_label: "ops-seed",
      addresses: [
        "0x5000000000000000000000000000000000000001",
        "0x5000000000000000000000000000000000000002",
        "0x5000000000000000000000000000000000000003",
      ],
    }),
  });
  assert.equal(importRes.status, 201);

  const first = await createInvoice(started.baseUrl, admin.token, 1010, `old-qr-${Date.now()}`);
  assert.equal(first.status, 201);
  const firstDetail = await getInvoice(started.baseUrl, admin.token, first.data.invoice_id);
  assert.equal(firstDetail.status, 200);

  const reissued = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(first.data.invoice_id)}/reissue`,
    {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `reissue-hardening-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(reissued.status, 201);
  assert.notEqual(reissued.data.receive_address, firstDetail.data.chain.recipient_address);

  const lateToOldQr = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: first.data.invoice_id,
      amount_jpyc: 1010,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: firstDetail.data.chain.recipient_address,
      confirmations: 2,
      tx_hash: randomTxHash("old-qr-late"),
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      observed_at: new Date(Date.now() + 1000).toISOString(),
    },
    `old-qr-late-${Date.now()}`
  );
  assert.equal(lateToOldQr.status, 200);
  assert.equal(lateToOldQr.data.status, "review_required");

  const oldInvoice = await getInvoice(started.baseUrl, admin.token, first.data.invoice_id);
  const newInvoice = await getInvoice(started.baseUrl, admin.token, reissued.data.invoice_id);
  assert.equal(oldInvoice.data.status, "review_required");
  assert.equal(oldInvoice.data.status_reason, "late_arrival_after_expiry");
  assert.equal(newInvoice.data.status, "issued");
  const oldReview = db.prepare(`SELECT reason_type FROM review_cases WHERE invoice_id = ?`).get(first.data.invoice_id);
  assert.equal(oldReview.reason_type, "LATE_PAYMENT");

  const disableTerminal = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/terminals/${encodeURIComponent(admin.terminalId)}/payments/disable`,
    {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `terminal-disable-${Date.now()}`,
      }),
      body: JSON.stringify({ reason: "incident_terminal" }),
    }
  );
  assert.equal(disableTerminal.status, 200);
  assert.equal(disableTerminal.data.terminal_disabled, true);

  const blockedByTerminal = await createInvoice(started.baseUrl, admin.token, 1111, `terminal-blocked-${Date.now()}`);
  assert.equal(blockedByTerminal.status, 503);
  assert.equal(blockedByTerminal.data.error.code, "PAYMENTS_DISABLED");
  assert.equal(blockedByTerminal.data.error.details.terminal_disabled, true);

  const enableTerminal = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/terminals/${encodeURIComponent(admin.terminalId)}/payments/enable`,
    {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `terminal-enable-${Date.now()}`,
      }),
      body: JSON.stringify({ reason: "incident_cleared" }),
    }
  );
  assert.equal(enableTerminal.status, 200);
  assert.equal(enableTerminal.data.terminal_disabled, false);

  const disableStore = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/payments/disable`,
    {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `store-disable-${Date.now()}`,
      }),
      body: JSON.stringify({ reason: "incident_store" }),
    }
  );
  assert.equal(disableStore.status, 200);
  assert.equal(disableStore.data.store_disabled, true);

  const blockedByStore = await createInvoice(started.baseUrl, admin.token, 1212, `store-blocked-${Date.now()}`);
  assert.equal(blockedByStore.status, 503);
  assert.equal(blockedByStore.data.error.code, "PAYMENTS_DISABLED");
  assert.equal(blockedByStore.data.error.details.store_disabled, true);

  db.prepare(
    `INSERT INTO app_config(key, value, updated_by, updated_at)
     VALUES ('payments.disabled', 'true', 'test-platform-ops', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(new Date().toISOString());

  const enableStore = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/payments/enable`,
    {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `store-enable-${Date.now()}`,
      }),
      body: JSON.stringify({ reason: "incident_cleared" }),
    }
  );
  assert.equal(enableStore.status, 200);
  assert.equal(enableStore.data.store_disabled, false);
  assert.equal(enableStore.data.global_disabled, true);
  assert.equal(enableStore.data.disabled, true);

  const stillBlockedByGlobal = await createInvoice(started.baseUrl, admin.token, 1313, `global-still-blocked-${Date.now()}`);
  assert.equal(stillBlockedByGlobal.status, 503);
  assert.equal(stillBlockedByGlobal.data.error.details.global_disabled, true);
  assert.equal(stillBlockedByGlobal.data.error.details.store_disabled, false);
  db.prepare(`UPDATE app_config SET value = 'false', updated_by = 'test-cleanup', updated_at = ? WHERE key = 'payments.disabled'`)
    .run(new Date().toISOString());

  const audit = await apiRequest(started.baseUrl, "/api/v1/audit-logs?limit=200", {
    headers: authHeaders(admin.token),
  });
  const actions = (audit.data.audit_logs || []).map((row) => row.action);
  assert.ok(actions.includes("payments.store_disabled"));
  assert.ok(actions.includes("payments.store_enabled"));
  assert.ok(actions.includes("payments.terminal_disabled"));
  assert.ok(actions.includes("payments.terminal_enabled"));
});

test("negative permission, public exposure, and rate-limit guards stay enforced", async (t) => {
  const env = baseServerEnv({
    PUBLIC_RATE_LIMIT_MAX: "2",
    PUBLIC_RATE_LIMIT_WINDOW_MS: "60000",
  });
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });

  const createStaff = await apiRequest(started.baseUrl, "/api/v1/staff", {
    method: "POST",
    headers: authHeaders(admin.token, {
      "content-type": "application/json",
      "idempotency-key": `staff-create-${Date.now()}`,
    }),
    body: JSON.stringify({
      staff_name: "Floor Staff",
      role: "staff",
      pin: "2468",
      status: "active",
    }),
  });
  assert.equal(createStaff.status, 201);

  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: "2468",
    staffName: "Floor Staff",
  });

  const invoice = await createInvoice(started.baseUrl, admin.token, 1313, `perm-invoice-${Date.now()}`);
  assert.equal(invoice.status, 201);
  const overpay = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: invoice.data.invoice_id,
      amount_jpyc: 1500,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("perm-overpay"),
      from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    `perm-overpay-${Date.now()}`
  );
  assert.equal(overpay.status, 200);
  assert.equal(overpay.data.status, "review_required");

  const detail = await getInvoice(started.baseUrl, admin.token, invoice.data.invoice_id);
  assert.ok(detail.data.review_case_id);

  const reviewForbidden = await apiRequest(started.baseUrl, `/api/v1/reviews/${encodeURIComponent(detail.data.review_case_id)}`, {
    method: "PATCH",
    headers: authHeaders(staff.token, {
      "content-type": "application/json",
      "idempotency-key": `review-forbidden-${Date.now()}`,
    }),
    body: JSON.stringify({ status: "resolved" }),
  });
  assert.equal(reviewForbidden.status, 403);

  const exportForbidden = await apiRequest(started.baseUrl, "/api/v1/audit-logs/export?format=json&limit=10", {
    headers: authHeaders(staff.token),
  });
  assert.equal(exportForbidden.status, 403);

  const controlForbidden = await apiRequest(started.baseUrl, "/api/v1/admin/payments/disable", {
    method: "POST",
    headers: authHeaders(staff.token, {
      "content-type": "application/json",
      "idempotency-key": `control-forbidden-${Date.now()}`,
    }),
    body: JSON.stringify({ reason: "not-allowed" }),
  });
  assert.equal(controlForbidden.status, 403);

  const loginResponse = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalCode: env.TERMINAL_CODE,
      staffPin: env.STAFF_PIN,
      staffName: "Demo Staff",
    }),
  });
  assert.equal(loginResponse.status, 201);
  assert.equal(loginResponse.headers.get("set-cookie"), null);

  const signed = parsePaymentUrl(invoice.data.payment_url);
  const noSig = await apiRequest(started.baseUrl, `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}`);
  assert.equal(noSig.status, 401);

  const wrongSig1 = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}?sig=bad&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`
  );
  const wrongSig2 = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}?sig=bad2&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`
  );
  const wrongSig3 = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}?sig=bad3&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`
  );
  assert.equal(wrongSig1.status, 401);
  assert.equal(wrongSig2.status, 429);
  assert.equal(wrongSig3.status, 429);
});

test("consent endpoint: requires a valid signature and fails closed without published policy configuration", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);

  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });

  const inv = await createInvoice(started.baseUrl, admin.token, 500, `consent-test-${Date.now()}`);
  assert.equal(inv.status, 201);
  const parsed = parsePaymentUrl(inv.data.payment_url);
  assert.ok(parsed.sig, "payment_url must include sig");

  const consentBody = JSON.stringify({
    terms_version: "draft-v1",
    privacy_version: "draft-v1",
    refund_policy_version: "draft-v1",
  });

  const consentUrl = `/api/v1/public/invoices/${encodeURIComponent(parsed.invoiceId)}/consent?sig=${encodeURIComponent(parsed.sig)}&exp=${encodeURIComponent(parsed.exp)}&nonce=${encodeURIComponent(parsed.nonce)}`;

  const blocked = await apiRequest(started.baseUrl, consentUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: consentBody,
  });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.data.error.code, "POLICY_CONFIGURATION_NOT_READY");
  assert.deepEqual(blocked.data.error.details.missing_keys, ["terms", "privacy", "refund"]);
  assert.deepEqual(blocked.data.error.details.missing_version_keys, ["terms_version", "privacy_version", "refund_policy_version"]);
  const consentAuditCount = db
    .prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer_policy_consent' AND target_id = ?`)
    .get(parsed.invoiceId).count;
  assert.equal(consentAuditCount, 0, "blocked consent must not create audit evidence");

  const badSig = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(parsed.invoiceId)}/consent?sig=invalidsig&exp=${encodeURIComponent(parsed.exp)}&nonce=${encodeURIComponent(parsed.nonce)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: consentBody }
  );
  assert.equal(badSig.status, 401);
  assert.equal(badSig.data.error.code, "UNAUTHORIZED");

  const noInvoice = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/nonexistent-id/consent?sig=${encodeURIComponent(parsed.sig)}&exp=${encodeURIComponent(parsed.exp)}&nonce=${encodeURIComponent(parsed.nonce)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: consentBody }
  );
  assert.equal(noInvoice.status, 401);
});

test("session timeout expires API access without breaking login", async (t) => {
  const env = baseServerEnv({
    SESSION_TTL_SEC: "1",
  });
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  const expired = await apiRequest(started.baseUrl, `/api/v1/stores/${encodeURIComponent(admin.storeId)}/settings`, {
    headers: authHeaders(admin.token),
  });
  assert.equal(expired.status, 401);
  assert.equal(expired.data.error.code, "UNAUTHORIZED");
});
