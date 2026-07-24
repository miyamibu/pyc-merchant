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
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("refund evidence registry enforces two-person rule and keeps recorded state until verification", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);

  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const requester = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const approver = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.SECOND_ADMIN_PIN,
  });

  const invoice = await createInvoice(started.baseUrl, requester.token, 2000, `refund-reg-${Date.now()}`);
  assert.equal(invoice.status, 201);

  const overpay = await ingestManualPayment(
    started.baseUrl,
    requester.token,
    {
      invoice_id: invoice.data.invoice_id,
      amount_jpyc: 2300,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("refund-reg-overpay"),
      from_address: "0x4444444444444444444444444444444444444444",
    },
    `refund-reg-ingest-${Date.now()}`
  );
  assert.equal(overpay.status, 200);

  const detail = await getInvoice(started.baseUrl, requester.token, invoice.data.invoice_id);
  assert.equal(detail.status, 200);
  assert.ok(detail.data.review_case_id);

  const request = await apiRequest(started.baseUrl, "/api/v1/refunds", {
    method: "POST",
    headers: authHeaders(requester.token, {
      "content-type": "application/json",
      "idempotency-key": `refund-reg-request-${Date.now()}`,
    }),
    body: JSON.stringify({
      review_case_id: detail.data.review_case_id,
      refund_amount_jpyc: 100,
      refund_to_address: "0x4444444444444444444444444444444444444444",
      refund_chain_id: env.CHAIN_ID,
      reason: "OVERPAYMENT",
      evidence_note_path: "docs/production/evidence/demo/refund-note.md",
      customer_note: "過入金差額の返金証跡です。",
    }),
  });
  assert.equal(request.status, 201);
  assert.equal(request.data.original_invoice_id, invoice.data.invoice_id);
  assert.equal(typeof request.data.checkout_session_id, "string");
  assert.equal(request.data.evidence_note_path, "docs/production/evidence/demo/refund-note.md");
  assert.equal(request.data.customer_note, "過入金差額の返金証跡です。");
  assert.ok(Array.isArray(request.data.audit_log_refs));

  const approved = await apiRequest(started.baseUrl, `/api/v1/refunds/${encodeURIComponent(request.data.refund_request_id)}/approve`, {
    method: "POST",
    headers: authHeaders(approver.token, {
      "content-type": "application/json",
      "idempotency-key": `refund-reg-approve-${Date.now()}`,
    }),
    body: "{}",
  });
  assert.equal(approved.status, 200);

  const executeByApprover = await apiRequest(started.baseUrl, `/api/v1/refunds/${encodeURIComponent(request.data.refund_request_id)}/execute`, {
    method: "POST",
    headers: authHeaders(approver.token, {
      "content-type": "application/json",
      "idempotency-key": `refund-reg-exec-approver-${Date.now()}`,
    }),
    body: JSON.stringify({
      executor_type: "manual",
      refund_tx_hash: randomTxHash("refund-reg-approver"),
    }),
  });
  assert.equal(executeByApprover.status, 409);
  assert.equal(executeByApprover.data.error.code, "TWO_PERSON_REQUIRED");

  const executeByRequester = await apiRequest(started.baseUrl, `/api/v1/refunds/${encodeURIComponent(request.data.refund_request_id)}/execute`, {
    method: "POST",
    headers: authHeaders(requester.token, {
      "content-type": "application/json",
      "idempotency-key": `refund-reg-exec-requester-${Date.now()}`,
    }),
    body: JSON.stringify({
      executor_type: "manual",
      refund_tx_hash: randomTxHash("refund-reg-requester"),
      executed_wallet: "0x5555555555555555555555555555555555555555",
      evidence_note_path: "docs/production/evidence/demo/refund-executed.md",
    }),
  });
  assert.equal(executeByRequester.status, 200);
  assert.equal(executeByRequester.data.status, "recorded");
  assert.equal(typeof executeByRequester.data.refund_case_id, "string");
  assert.equal(typeof executeByRequester.data.source_invoice_id, "string");
  assert.equal(executeByRequester.data.original_invoice_id, invoice.data.invoice_id);
  assert.equal(executeByRequester.data.executed_wallet, "0x5555555555555555555555555555555555555555");
  assert.equal(executeByRequester.data.evidence_note_path, "docs/production/evidence/demo/refund-executed.md");
  assert.equal(executeByRequester.data.customer_note, "過入金差額の返金証跡です。");
  assert.ok(executeByRequester.data.audit_log_refs.some((row) => row.action === "refund.executed"));
  assert.equal(executeByRequester.data.verified_onchain, false);

  const readBack = await apiRequest(started.baseUrl, `/api/v1/refunds/${encodeURIComponent(request.data.refund_request_id)}`, {
    headers: authHeaders(requester.token),
  });
  assert.equal(readBack.status, 200);
  assert.notEqual(readBack.data.refund_case_id, request.data.refund_request_id);
  assert.equal(readBack.data.executed_wallet, "0x5555555555555555555555555555555555555555");
  assert.equal(readBack.data.evidence_note_path, "docs/production/evidence/demo/refund-executed.md");
  assert.ok(Array.isArray(readBack.data.audit_log_refs));

  const businessDateJst = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const blockedClose = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(requester.token, {
      "content-type": "application/json",
      "idempotency-key": `refund-close-block-${Date.now()}`,
    }),
    body: JSON.stringify({
      business_date: businessDateJst,
      admin_approval: true,
      unresolved_review_reason: "refund evidence blocker test",
    }),
  });
  assert.equal(blockedClose.status, 409);
  assert.equal(blockedClose.data.error.code, "UNRESOLVED_REFUNDS");
  assert.match(blockedClose.data.error.message, /締めできません。未完了の返金証跡を先に処理してください。/);
  assert.ok(blockedClose.data.error.unresolved_refunds.some((row) => row.refund_case_id === request.data.refund_request_id));

  db.prepare(`UPDATE refund_requests SET status = 'succeeded', verified_at = ?, updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    new Date().toISOString(),
    request.data.refund_request_id
  );
  const closeAfterResolvedRefund = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(requester.token, {
      "content-type": "application/json",
      "idempotency-key": `refund-close-resolved-${Date.now()}`,
    }),
    body: JSON.stringify({
      business_date: businessDateJst,
      admin_approval: true,
      unresolved_review_reason: "refund evidence resolved test",
    }),
  });
  assert.equal(closeAfterResolvedRefund.status, 200);

  const auditLogs = await apiRequest(started.baseUrl, "/api/v1/audit-logs?limit=200", {
    headers: authHeaders(requester.token),
  });
  assert.equal(auditLogs.status, 200);
  const actions = (auditLogs.data.audit_logs || []).map((row) => row.action);
  assert.ok(actions.includes("refund.executed"));
});
