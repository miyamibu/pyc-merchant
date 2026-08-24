import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  ingestManualPayment,
  parsePaymentUrl,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();
const REFUND_TO_ADDRESS = "0x4444444444444444444444444444444444444444";

function jsonHeaders(token, idempotencyKey) {
  return authHeaders(token, {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  });
}

async function requestRefund(baseUrl, token, reviewCaseId, amount, idempotencyKey, extra = {}) {
  return apiRequest(baseUrl, "/api/v1/refunds", {
    method: "POST",
    headers: jsonHeaders(token, idempotencyKey),
    body: JSON.stringify({
      review_case_id: reviewCaseId,
      refund_amount_jpyc: amount,
      refund_to_address: REFUND_TO_ADDRESS,
      refund_chain_id: "137",
      reason: "OVERPAYMENT",
      ...extra,
    }),
  });
}

test("backend P0 safety guards preserve audit secrecy, refund balance, and public state evidence", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);

  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const login = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalCode: env.TERMINAL_CODE, staffPin: env.STAFF_PIN }),
  });
  assert.equal(login.status, 201);
  assert.equal(login.data.staff_name, "Demo Staff");
  assert.ok(Array.isArray(login.data.effective_permissions));
  assert.ok(login.data.effective_permissions.includes("staff.manage"));
  assert.ok(Number.isFinite(new Date(login.data.expires_at).getTime()));
  const adminToken = login.data.token;

  const createdStaff = await apiRequest(started.baseUrl, "/api/v1/staff", {
    method: "POST",
    headers: jsonHeaders(adminToken, `staff-create-${Date.now()}`),
    body: JSON.stringify({
      staff_name: "Safe Projection Staff",
      role: "staff",
      pin: "2468",
      status: "active",
    }),
  });
  assert.equal(createdStaff.status, 201);
  assert.equal(Object.hasOwn(createdStaff.data.staff, "pin_hash"), false);

  const patchedStaff = await apiRequest(
    started.baseUrl,
    `/api/v1/staff/${encodeURIComponent(createdStaff.data.staff.id)}`,
    {
      method: "PATCH",
      headers: jsonHeaders(adminToken, `staff-patch-${Date.now()}`),
      body: JSON.stringify({ role: "operator" }),
    }
  );
  assert.equal(patchedStaff.status, 200);
  assert.equal(Object.hasOwn(patchedStaff.data.staff, "pin_hash"), false);

  const secondAdminLogin = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalCode: env.TERMINAL_CODE,
      staffPin: env.SECOND_ADMIN_PIN,
      staffName: "Demo Approver",
    }),
  });
  assert.equal(secondAdminLogin.status, 201);
  const revoked = await apiRequest(
    started.baseUrl,
    `/api/v1/terminal-sessions/${encodeURIComponent(secondAdminLogin.data.sessionId)}/revoke`,
    {
      method: "POST",
      headers: jsonHeaders(adminToken, `session-revoke-${Date.now()}`),
      body: "{}",
    }
  );
  assert.equal(revoked.status, 200);

  const refundInvoice = await createInvoice(started.baseUrl, adminToken, 1000, `refund-cap-invoice-${Date.now()}`);
  assert.equal(refundInvoice.status, 201);
  const overpay = await ingestManualPayment(
    started.baseUrl,
    adminToken,
    {
      invoice_id: refundInvoice.data.invoice_id,
      amount_jpyc: 1500,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("refund-cap-overpay"),
      from_address: REFUND_TO_ADDRESS,
    },
    `refund-cap-payment-${Date.now()}`
  );
  assert.equal(overpay.status, 200);
  assert.equal(overpay.data.status, "review_required");
  const review = db.prepare(`SELECT id FROM review_cases WHERE invoice_id = ?`).get(refundInvoice.data.invoice_id);
  assert.ok(review?.id);

  const parallelKeyA = `refund-cap-a-${Date.now()}`;
  const parallelKeyB = `refund-cap-b-${Date.now()}`;
  const refundAuditSecretFixture = { customer_note: refundInvoice.data.payment_url };
  const parallel = await Promise.all([
    requestRefund(started.baseUrl, adminToken, review.id, 300, parallelKeyA, refundAuditSecretFixture),
    requestRefund(started.baseUrl, adminToken, review.id, 300, parallelKeyB, refundAuditSecretFixture),
  ]);
  assert.deepEqual(parallel.map((result) => result.status).sort(), [200, 201]);
  const successful = parallel.find((result) => result.status === 201);
  const deduplicated = parallel.find((result) => result.status === 200);
  assert.ok(successful);
  assert.ok(deduplicated);
  assert.equal(deduplicated.data.refund_request_id, successful.data.refund_request_id);

  const semanticRows = db
    .prepare(
      `SELECT id, refund_amount_jpyc_base, customer_note, evidence_screenshot, evidence_note_path
       FROM refund_requests WHERE invoice_id = ? ORDER BY rowid ASC`
    )
    .all(refundInvoice.data.invoice_id);
  assert.equal(semanticRows.length, 1, "semantic duplicate must reserve exactly one refund row");
  assert.equal(semanticRows[0].id, successful.data.refund_request_id);
  assert.equal(String(semanticRows[0].refund_amount_jpyc_base), "300000000");
  assert.equal(semanticRows[0].customer_note, "[REDACTED_SIGNED_URL]");
  assert.doesNotMatch(JSON.stringify(semanticRows[0]), /\/pay\?ref=|[?&](?:sig|nonce)=/i);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM refund_cases WHERE invoice_id = ?`).get(refundInvoice.data.invoice_id).count,
    1,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'refund.requested' AND target_id = ?`)
      .get(successful.data.refund_request_id).count,
    1,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'refund.request_deduplicated' AND target_id = ?`)
      .get(successful.data.refund_request_id).count,
    1,
  );

  for (const [index, key] of [parallelKeyA, parallelKeyB].entries()) {
    const replay = await requestRefund(started.baseUrl, adminToken, review.id, 300, key, refundAuditSecretFixture);
    assert.equal(replay.status, parallel[index].status);
    assert.equal(replay.data.refund_request_id, successful.data.refund_request_id);
  }

  const overBeforeRemaining = await requestRefund(
    started.baseUrl,
    adminToken,
    review.id,
    201,
    `refund-cap-over-before-remaining-${Date.now()}`
  );
  assert.equal(overBeforeRemaining.status, 400);
  assert.equal(overBeforeRemaining.data.error.code, "OVER_REFUND");
  assert.equal(overBeforeRemaining.data.error.details.reserved_refund_amount_jpyc_base, "300000000");
  assert.equal(overBeforeRemaining.data.error.details.remaining_refund_amount_jpyc_base, "200000000");

  const remaining = await requestRefund(
    started.baseUrl,
    adminToken,
    review.id,
    200,
    `refund-cap-remaining-${Date.now()}`
  );
  assert.equal(remaining.status, 201);
  const overAfterReservation = await requestRefund(
    started.baseUrl,
    adminToken,
    review.id,
    1,
    `refund-cap-over-${Date.now()}`
  );
  assert.equal(overAfterReservation.status, 400);
  assert.equal(overAfterReservation.data.error.details.reserved_refund_amount_jpyc_base, "500000000");
  assert.equal(overAfterReservation.data.error.details.remaining_refund_amount_jpyc_base, "0");
  const reservedRows = db
    .prepare(`SELECT refund_amount_jpyc_base FROM refund_requests WHERE invoice_id = ?`)
    .all(refundInvoice.data.invoice_id);
  const reservedTotal = reservedRows.reduce((sum, row) => sum + BigInt(String(row.refund_amount_jpyc_base)), 0n);
  assert.equal(reservedTotal.toString(), "500000000");

  const businessDateJst = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const blockedRefundExport = await apiRequest(started.baseUrl, "/api/v1/settlement-exports", {
    method: "POST",
    headers: jsonHeaders(adminToken, `refund-export-${Date.now()}`),
    body: JSON.stringify({ business_date: businessDateJst, format: "json" }),
  });
  assert.equal(blockedRefundExport.status, 409);
  assert.equal(blockedRefundExport.data.error.code, "SETTLEMENT_HARD_GATE_BLOCKED");

  const resolvedReview = await apiRequest(
    started.baseUrl,
    `/api/v1/reviews/${encodeURIComponent(review.id)}`,
    {
      method: "PATCH",
      headers: jsonHeaders(adminToken, `review-resolve-${Date.now()}`),
      body: JSON.stringify({
        status: "resolved",
        disposition: "cancelled_no_sale",
        resolution_note: "focused public invoice fixture",
      }),
    }
  );
  assert.equal(resolvedReview.status, 200);

  const refundExport = await apiRequest(started.baseUrl, "/api/v1/settlement-exports", {
    method: "POST",
    headers: jsonHeaders(adminToken, `refund-export-after-review-${Date.now()}`),
    body: JSON.stringify({ business_date: businessDateJst, format: "json" }),
  });
  assert.equal(refundExport.status, 201);
  const exportRead = await apiRequest(
    started.baseUrl,
    `/api/v1/settlement-exports/${encodeURIComponent(refundExport.data.export_id)}`,
    { headers: authHeaders(adminToken) }
  );
  assert.equal(exportRead.status, 200);
  const refundExportRow = exportRead.data.rows.find((row) => row.invoice_id === refundInvoice.data.invoice_id);
  assert.ok(refundExportRow);
  assert.equal(refundExportRow.refund_reference_status, "complete");
  assert.equal(refundExportRow.refund_reference_count, 2);
  assert.equal(refundExportRow.refund_requested_amount_jpyc_base, 500000000);
  assert.equal(refundExportRow.refund_reserved_amount_jpyc_base, 500000000);
  assert.equal(refundExportRow.refund_succeeded_amount_jpyc_base, 0);
  assert.equal(refundExportRow.refund_references.length, 2);
  const download = await fetch(
    `${started.baseUrl}/api/v1/settlement-exports/${encodeURIComponent(refundExport.data.export_id)}/download?format=json`,
    { headers: authHeaders(adminToken) }
  );
  assert.equal(download.status, 200);
  const downloadText = await download.text();
  const downloadHash = createHash("sha256").update(downloadText).digest("hex");
  assert.equal(download.headers.get("x-content-sha256"), downloadHash);
  assert.equal(refundExport.data.content_hashes.json, downloadHash);

  const publicInvoice = await createInvoice(started.baseUrl, adminToken, 777, `public-state-invoice-${Date.now()}`);
  assert.equal(publicInvoice.status, 201);
  const signed = parsePaymentUrl(publicInvoice.data.payment_url);
  const publicPath =
    `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}`
    + `?sig=${encodeURIComponent(signed.sig)}&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`;
  const beforePayment = await apiRequest(started.baseUrl, publicPath);
  assert.equal(beforePayment.status, 200);
  assert.equal(beforePayment.data.paid_tx_hash, null);
  assert.equal(beforePayment.data.confirmed_at, null);
  assert.equal(beforePayment.data.chain_recorded_at, null);
  assert.equal(beforePayment.data.status_version, beforePayment.data.created_at);
  assert.ok(Number.isFinite(new Date(beforePayment.data.server_now).getTime()));
  assert.ok(Number.isInteger(beforePayment.data.ttl_remaining_sec));

  const terminalEntry = await fetch(`${started.baseUrl}/t/${encodeURIComponent(login.data.public_entry_token)}`, {
    redirect: "manual",
  });
  assert.equal(terminalEntry.status, 302);
  assert.match(String(terminalEntry.headers.get("location") || ""), /^\/terminal-entry\.html\?token=/);
  const readyEntry = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(login.data.public_entry_token)}`
  );
  assert.equal(readyEntry.status, 200);
  assert.equal(readyEntry.data.status, "ready");
  assert.equal(readyEntry.data.pay_url, publicInvoice.data.payment_url);

  const paidTxHash = randomTxHash("public-confirmed-at");
  const paid = await ingestManualPayment(
    started.baseUrl,
    adminToken,
    {
      invoice_id: publicInvoice.data.invoice_id,
      amount_jpyc: 777,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: paidTxHash,
      token_amount_atomic: "777000000000000000000",
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      observed_at: "2026-07-15T01:02:03.000Z",
      block_timestamp: "2026-07-15T01:02:00.000Z",
    },
    `public-confirmed-payment-${Date.now()}`
  );
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, "paid");
  const afterPayment = await apiRequest(started.baseUrl, publicPath);
  assert.equal(afterPayment.status, 200);
  assert.equal(afterPayment.data.paid_tx_hash, paidTxHash);
  const recordedPaymentEvent = db
    .prepare(`SELECT created_at, block_timestamp FROM payment_events WHERE invoice_id = ? AND lower(tx_hash) = lower(?)`)
    .get(publicInvoice.data.invoice_id, paidTxHash);
  assert.equal(afterPayment.data.confirmed_at, recordedPaymentEvent.created_at);
  assert.equal(afterPayment.data.chain_recorded_at, "2026-07-15T01:02:00.000Z");
  assert.equal(afterPayment.data.chain_recorded_at, recordedPaymentEvent.block_timestamp);
  assert.notEqual(afterPayment.data.confirmed_at, afterPayment.data.chain_recorded_at);
  assert.notEqual(afterPayment.data.status_version, beforePayment.data.status_version);

  db.prepare(`UPDATE refund_requests SET status = 'rejected', updated_at = ? WHERE invoice_id = ?`).run(
    new Date().toISOString(),
    refundInvoice.data.invoice_id
  );
  const close = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: jsonHeaders(adminToken, `bound-close-${Date.now()}`),
    body: JSON.stringify({ business_date: businessDateJst, admin_approval: true }),
  });
  assert.equal(close.status, 200);
  assert.ok(close.data.export_id);
  assert.ok(close.data.export_run_id);
  const laterExport = await apiRequest(started.baseUrl, "/api/v1/settlement-exports", {
    method: "POST",
    headers: jsonHeaders(adminToken, `later-export-${Date.now()}`),
    body: JSON.stringify({ business_date: businessDateJst, format: "json" }),
  });
  assert.equal(laterExport.status, 201);
  assert.notEqual(laterExport.data.export_run_id, close.data.export_run_id);
  const repeatedClose = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: jsonHeaders(adminToken, `bound-close-repeat-${Date.now()}`),
    body: JSON.stringify({ business_date: businessDateJst, admin_approval: true }),
  });
  assert.equal(repeatedClose.status, 200);
  assert.equal(repeatedClose.data.already_closed, true);
  assert.equal(repeatedClose.data.export_id, close.data.export_id);
  assert.equal(repeatedClose.data.export_run_id, close.data.export_run_id);

  const storedAuditText = db
    .prepare(`SELECT before_state, after_state FROM audit_logs ORDER BY rowid ASC`)
    .all()
    .map((row) => `${row.before_state || ""}\n${row.after_state || ""}`)
    .join("\n");
  assert.doesNotMatch(storedAuditText, /pin_hash|token_hash|public_entry_token|\/pay\?ref=/i);

  const legacyRow = db.prepare(`SELECT id FROM audit_logs ORDER BY rowid ASC LIMIT 1`).get();
  assert.ok(legacyRow?.id);
  db.prepare(`UPDATE audit_logs SET store_id = ?, after_state = ?, target_id = ?, request_id = ?, idempotency_key = ? WHERE id = ?`).run(
    "store-001",
    JSON.stringify({
      pin_hash: "legacy-pin-secret",
      token_hash: "legacy-token-secret",
      public_entry_token: "legacy-public-token",
      payment_url: "https://merchant.example/pay?ref=legacy-signed-secret",
      support_note: "https://merchant.example/api/v1/public/invoices/inv-1?sig=legacy-api-signature&nonce=legacy-nonce",
      private_key: "legacy-private-key",
      wallet_mnemonic: "legacy mnemonic words",
      account_password: "legacy-password",
      oauth_client_secret: "legacy-client-secret",
      provider_api_key: "legacy-api-key",
      safe: "visible",
    }),
    "https://merchant.example/pay?ref=legacy-target-secret",
    "Bearer legacy-request-secret",
    "https://merchant.example/api/v1/public/invoices/inv-1?sig=legacy-idempotency-secret&nonce=legacy-nonce",
    legacyRow.id
  );
  const auditList = await apiRequest(started.baseUrl, "/api/v1/audit-logs?limit=500", {
    headers: authHeaders(adminToken),
  });
  assert.equal(auditList.status, 200);
  const auditListText = JSON.stringify(auditList.data);
  assert.doesNotMatch(
    auditListText,
    /legacy-pin-secret|legacy-token-secret|legacy-public-token|legacy-signed-secret|legacy-api-signature|legacy-private-key|legacy mnemonic words|legacy-password|legacy-client-secret|legacy-api-key|legacy-target-secret|legacy-request-secret|legacy-idempotency-secret/
  );
  assert.match(auditListText, /visible/);
  const auditExport = await apiRequest(started.baseUrl, "/api/v1/audit-logs/export?format=json&limit=500", {
    headers: authHeaders(adminToken),
  });
  assert.equal(auditExport.status, 200);
  assert.doesNotMatch(
    JSON.stringify(auditExport.data),
    /legacy-pin-secret|legacy-token-secret|legacy-public-token|legacy-signed-secret|legacy-api-signature|legacy-private-key|legacy mnemonic words|legacy-password|legacy-client-secret|legacy-api-key|legacy-target-secret|legacy-request-secret|legacy-idempotency-secret/
  );
  const auditCsv = await apiRequest(started.baseUrl, "/api/v1/audit-logs/export?format=csv&limit=500", {
    headers: authHeaders(adminToken),
  });
  assert.equal(auditCsv.status, 200);
  assert.equal(typeof auditCsv.data, "string");
  assert.doesNotMatch(
    auditCsv.data,
    /before_state|after_state|legacy-pin-secret|legacy-token-secret|legacy-target-secret|legacy-request-secret|legacy-idempotency-secret/
  );

  const duplicatePinStaff = await apiRequest(started.baseUrl, "/api/v1/staff", {
    method: "POST",
    headers: jsonHeaders(adminToken, `staff-duplicate-pin-${Date.now()}`),
    body: JSON.stringify({
      staff_name: "Duplicate PIN Staff",
      role: "staff",
      pin: env.STAFF_PIN,
      status: "active",
    }),
  });
  assert.equal(duplicatePinStaff.status, 201);
  const lockoutBeforeAmbiguousLogin = db
    .prepare(`SELECT failed_attempts, locked_until FROM terminal_login_lockouts WHERE terminal_code = ?`)
    .get(env.TERMINAL_CODE) || { failed_attempts: 0, locked_until: null };
  const ambiguousLogin = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalCode: env.TERMINAL_CODE, staffPin: env.STAFF_PIN }),
  });
  assert.equal(ambiguousLogin.status, 401);
  assert.equal(ambiguousLogin.data.error.code, "UNAUTHORIZED");
  assert.deepEqual(ambiguousLogin.data.error.details, {});
  assert.doesNotMatch(JSON.stringify(ambiguousLogin.data), /Demo Staff|Duplicate PIN Staff/);
  const lockoutAfterAmbiguousLogin = db
    .prepare(`SELECT failed_attempts, locked_until FROM terminal_login_lockouts WHERE terminal_code = ?`)
    .get(env.TERMINAL_CODE) || { failed_attempts: 0, locked_until: null };
  assert.deepEqual(lockoutAfterAmbiguousLogin, lockoutBeforeAmbiguousLogin);
});
