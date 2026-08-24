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
  loginAs,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

function jsonHeaders(token, idempotencyKey) {
  return authHeaders(token, {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  });
}

function currentBusinessDateJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function sourceLedgerSnapshotHash(row, primaryPaymentEvidence = null) {
  return createHash("sha256").update(JSON.stringify({
    invoice_id: row.invoice_id,
    payment_session_id: row.payment_session_id,
    provider_payment_ref: row.provider_payment_ref,
    provider_settlement_ref: row.provider_settlement_ref,
    onchain_transfer_ref: row.onchain_transfer_ref,
    primary_payment_evidence: primaryPaymentEvidence,
    invoice_status: row.invoice_status,
    review_status: row.review_status,
    refund_references: row.refund_references,
    refund_attribution: row.refund_attribution,
    accounting_status: row.accounting_status,
    audit_log_refs: row.audit_log_refs,
  })).digest("hex");
}

test("settlement snapshot preserves every audit reference and binds the canonical primary transfer identity", async (t) => {
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

  const reviewedInvoice = await createInvoice(
    started.baseUrl,
    admin.token,
    1000,
    `audit-ref-invoice-${Date.now()}`,
  );
  assert.equal(reviewedInvoice.status, 201);
  const overpay = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: reviewedInvoice.data.invoice_id,
      amount_jpyc: 1100,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("audit-ref-overpay"),
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    `audit-ref-payment-${Date.now()}`,
  );
  assert.equal(overpay.status, 200);
  assert.equal(overpay.data.status, "review_required");
  const review = db.prepare(`SELECT id FROM review_cases WHERE invoice_id = ?`).get(reviewedInvoice.data.invoice_id);
  assert.ok(review?.id);

  for (let index = 0; index < 105; index += 1) {
    const updated = await apiRequest(
      started.baseUrl,
      `/api/v1/reviews/${encodeURIComponent(review.id)}`,
      {
        method: "PATCH",
        headers: jsonHeaders(admin.token, `audit-ref-review-${index}-${Date.now()}`),
        body: JSON.stringify({
          status: "in_progress",
          assigned_to: `audit-ref-operator-${index % 3}`,
          admin_note: `audit reference completeness ${index}`,
        }),
      },
    );
    assert.equal(updated.status, 200, `review audit fixture ${index} should be accepted`);
  }
  const resolved = await apiRequest(
    started.baseUrl,
    `/api/v1/reviews/${encodeURIComponent(review.id)}`,
    {
      method: "PATCH",
      headers: jsonHeaders(admin.token, `audit-ref-resolve-${Date.now()}`),
      body: JSON.stringify({
        status: "rejected",
        disposition: "cancelled_no_sale",
        resolution_status: "cancelled",
        resolution_note: "audit reference completeness fixture resolved",
      }),
    },
  );
  assert.equal(resolved.status, 200);
  const expectedReviewAuditIds = db
    .prepare(`SELECT id FROM audit_logs WHERE target_type = 'review' AND target_id = ? ORDER BY created_at ASC, id ASC`)
    .all(review.id)
    .map((row) => row.id);
  assert.ok(
    expectedReviewAuditIds.length >= 106,
    `expected at least 106 ordered review audit refs, got ${expectedReviewAuditIds.length}`,
  );

  const paidInvoice = await createInvoice(
    started.baseUrl,
    admin.token,
    777,
    `primary-transfer-invoice-${Date.now()}`,
  );
  assert.equal(paidInvoice.status, 201);
  const paidTxHash = randomTxHash("canonical-primary-transfer");
  const paid = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: paidInvoice.data.invoice_id,
      amount_jpyc: 777,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: paidTxHash,
      log_index: 7,
      token_amount_atomic: "777000000000000000000",
      from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    `primary-transfer-payment-${Date.now()}`,
  );
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, "paid");

  db.prepare(
    `INSERT INTO payment_events
     (id, invoice_id, event_type, chain_id, tx_hash, log_index, block_number, confirmations,
      from_address, to_address, token_contract, amount_jpyc, amount_jpyc_base, amount_atomic,
      chain_verified, token_verified, recipient_verified, canonical_status, within_expiry,
      recognition_status, observed_at, block_timestamp, detected_at, raw_payload, created_at,
      token_amount_atomic, ledger_amount_base, deadline_eligible)
     VALUES (?, ?, 'tx_detected', ?, ?, 1, 1, 99, ?, ?, ?, 777, 777000000, ?,
             0, 0, 0, 'disputed', 1, 'review_required', ?, ?, ?, '{}', ?, ?, 777000000, 1)`
  ).run(
    `noncanonical-earlier-${Date.now()}`,
    paidInvoice.data.invoice_id,
    env.CHAIN_ID,
    paidTxHash,
    "0xcccccccccccccccccccccccccccccccccccccccc",
    env.RECIPIENT_ADDRESS,
    env.TOKEN_CONTRACT,
    "777000000000000000000",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:00.000Z",
    "777000000000000000000",
  );

  const exported = await apiRequest(started.baseUrl, "/api/v1/settlement-exports", {
    method: "POST",
    headers: jsonHeaders(admin.token, `complete-lineage-export-${Date.now()}`),
    body: JSON.stringify({ business_date: currentBusinessDateJst(), format: "json" }),
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.data));
  const read = await apiRequest(
    started.baseUrl,
    `/api/v1/settlement-exports/${encodeURIComponent(exported.data.export_id)}`,
    { headers: authHeaders(admin.token) },
  );
  assert.equal(read.status, 200);

  const reviewedRow = read.data.rows.find((row) => row.invoice_id === reviewedInvoice.data.invoice_id);
  assert.ok(reviewedRow);
  const exportedReviewRefs = reviewedRow.audit_log_refs.filter((id) => expectedReviewAuditIds.includes(id));
  assert.equal(exportedReviewRefs.length, expectedReviewAuditIds.length);
  assert.equal(exportedReviewRefs[0], expectedReviewAuditIds[0]);
  assert.equal(exportedReviewRefs.at(-1), expectedReviewAuditIds.at(-1));
  assert.equal(reviewedRow.source_ledger_snapshot_hash, sourceLedgerSnapshotHash(reviewedRow));
  assert.equal(reviewedRow.evidence_hash, reviewedRow.source_ledger_snapshot_hash);

  const paidRow = read.data.rows.find((row) => row.invoice_id === paidInvoice.data.invoice_id);
  assert.ok(paidRow);
  assert.equal(paidRow.primary_tx_hash, paidTxHash);
  assert.equal(paidRow.primary_tx_log_index, 7);
  assert.equal(paidRow.onchain_transfer_ref, paidTxHash);
  assert.notEqual(paidRow.primary_tx_log_index, 1);

  const canonical = db.prepare(
    `SELECT pe.id AS payment_event_id, bt.id AS blockchain_transfer_id,
            pe.chain_id, pe.tx_hash, pe.log_index, pe.token_contract, pe.to_address,
            pe.token_amount_atomic, pe.canonical_status
     FROM invoices i
     JOIN blockchain_transfers bt ON bt.id = i.primary_recognized_transfer_id
     JOIN payment_events pe
       ON pe.invoice_id = i.id
      AND pe.chain_id = bt.chain_id
      AND lower(pe.tx_hash) = lower(bt.tx_hash)
      AND pe.log_index = bt.log_index
     WHERE i.id = ?`
  ).get(paidInvoice.data.invoice_id);
  assert.equal(paidRow.source_ledger_snapshot_hash, sourceLedgerSnapshotHash(paidRow, {
    blockchain_transfer_id: canonical.blockchain_transfer_id,
    payment_event_id: canonical.payment_event_id,
    chain_id: String(canonical.chain_id),
    tx_hash: String(canonical.tx_hash),
    log_index: Number(canonical.log_index),
    token_contract: String(canonical.token_contract).toLowerCase(),
    recipient_address: String(canonical.to_address).toLowerCase(),
    token_amount_atomic: String(canonical.token_amount_atomic),
    canonical_status: String(canonical.canonical_status),
  }));
});
