import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

test("confirmation waiting stays out of review incidents and blocks settlement explicitly", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(process.cwd(), env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const created = await createInvoice(started.baseUrl, staff.token, 1000, `confirmation-incident-${Date.now()}`);
  assert.equal(created.status, 201);
  const txHash = randomTxHash("confirmation-incident");
  const blockTimestamp = new Date(Date.now() - 1000).toISOString();
  const basePayload = {
    invoice_id: created.data.invoice_id,
    amount_jpyc: 1000,
    chain_id: env.CHAIN_ID,
    token_contract: env.TOKEN_CONTRACT,
    to_address: env.RECIPIENT_ADDRESS,
    tx_hash: txHash,
    log_index: 0,
    block_number: 200,
    block_timestamp: blockTimestamp,
    from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  const pending = await ingestManualPayment(
    started.baseUrl,
    staff.token,
    { ...basePayload, confirmations: 1 },
    `confirmation-incident-pending-${Date.now()}`,
  );
  assert.equal(pending.status, 200);
  assert.equal(pending.data.status, "confirming");

  const pendingReview = db.prepare(
    `SELECT id FROM review_cases WHERE invoice_id = ?`
  ).get(created.data.invoice_id);
  assert.equal(pendingReview, undefined);
  const pendingIncidentCount = db.prepare(
    `SELECT COUNT(*) AS count FROM review_incidents WHERE invoice_id = ?`
  ).get(created.data.invoice_id).count;
  assert.equal(pendingIncidentCount, 0);
  const pendingInvoice = db.prepare(
    `SELECT confirmation_started_at, confirmation_deadline_at, confirmation_sla_sec
     FROM invoices WHERE id = ?`
  ).get(created.data.invoice_id);
  assert.ok(pendingInvoice.confirmation_started_at);
  assert.ok(pendingInvoice.confirmation_deadline_at);
  assert.equal(pendingInvoice.confirmation_sla_sec, 900);

  const paid = await ingestManualPayment(
    started.baseUrl,
    staff.token,
    { ...basePayload, confirmations: 2 },
    `confirmation-incident-paid-${Date.now()}`,
  );
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, "paid");

  const reviews = await apiRequest(started.baseUrl, "/api/v1/reviews", {
    headers: authHeaders(staff.token),
  });
  assert.equal(reviews.status, 200);
  assert.equal(reviews.data.reviews.some((row) => row.invoice_id === created.data.invoice_id), false);

  const dailyStatus = await apiRequest(started.baseUrl, "/api/v1/settlements/daily-status", {
    headers: authHeaders(staff.token),
  });
  assert.equal(dailyStatus.status, 200);
  const blockerCodes = (dailyStatus.data.blockers || []).map((blocker) => blocker.code);
  assert.equal(blockerCodes.includes("OPEN_REVIEW_INCIDENTS"), false);
});

test("review resolution selects one incident and cannot silently resolve another", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(process.cwd(), env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const created = await createInvoice(started.baseUrl, staff.token, 1000, `incident-selector-${Date.now()}`);
  const payment = await ingestManualPayment(started.baseUrl, staff.token, {
    invoice_id: created.data.invoice_id,
    amount_jpyc: 1000,
    chain_id: env.CHAIN_ID,
    token_contract: env.TOKEN_CONTRACT,
    to_address: env.RECIPIENT_ADDRESS,
    confirmations: 2,
    tx_hash: randomTxHash("incident-selector-payment"),
    log_index: 0,
    block_number: 300,
    block_timestamp: new Date(Date.now() - 1000).toISOString(),
    from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(payment.data.status, "paid");

  const reviewId = randomUUID();
  const firstIncidentId = randomUUID();
  const secondIncidentId = randomUUID();
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO review_cases
     (id, invoice_id, reason_type, action_history_json, resolution_status, status, created_at, updated_at)
     VALUES (?, ?, 'OTHER', '[]', 'pending', 'open', ?, ?)`
  ).run(reviewId, created.data.invoice_id, timestamp, timestamp);
  const insertIncident = db.prepare(
    `INSERT INTO review_incidents
     (id, invoice_id, incident_type, evidence_fingerprint, primary_reason, status, resolution_status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', 'pending', ?)`
  );
  insertIncident.run(firstIncidentId, created.data.invoice_id, "MANUAL_INCIDENT_A", `fp-${firstIncidentId}`, "OTHER", timestamp);
  insertIncident.run(secondIncidentId, created.data.invoice_id, "MANUAL_INCIDENT_B", `fp-${secondIncidentId}`, "OTHER", timestamp);

  const resolveFirst = await apiRequest(started.baseUrl, `/api/v1/reviews/${reviewId}`, {
    method: "PATCH",
    headers: authHeaders(staff.token, {
      "content-type": "application/json",
      "idempotency-key": `resolve-first-${Date.now()}`,
    }),
    body: JSON.stringify({
      status: "resolved",
      resolution_note: "first incident reviewed",
      disposition: "accepted_as_paid",
      incident_id: firstIncidentId,
    }),
  });
  assert.equal(resolveFirst.status, 200);
  assert.equal(db.prepare(`SELECT status FROM review_incidents WHERE id = ?`).get(firstIncidentId).status, "resolved");
  assert.equal(db.prepare(`SELECT status FROM review_incidents WHERE id = ?`).get(secondIncidentId).status, "open");

  const resolveSecond = await apiRequest(started.baseUrl, `/api/v1/reviews/${reviewId}`, {
    method: "PATCH",
    headers: authHeaders(staff.token, {
      "content-type": "application/json",
      "idempotency-key": `resolve-second-${Date.now()}`,
    }),
    body: JSON.stringify({
      status: "resolved",
      resolution_note: "second incident reviewed",
      disposition: "accepted_as_paid",
      incident_id: secondIncidentId,
    }),
  });
  assert.equal(resolveSecond.status, 200);
  assert.equal(db.prepare(`SELECT status FROM review_incidents WHERE id = ?`).get(secondIncidentId).status, "resolved");

  const invalidTarget = await apiRequest(started.baseUrl, `/api/v1/reviews/${reviewId}`, {
    method: "PATCH",
    headers: authHeaders(staff.token, {
      "content-type": "application/json",
      "idempotency-key": `resolve-invalid-${Date.now()}`,
    }),
    body: JSON.stringify({
      status: "resolved",
      resolution_note: "must not resolve an unrelated incident",
      disposition: "accepted_as_paid",
      incident_id: randomUUID(),
    }),
  });
  assert.equal(invalidTarget.status, 404);
  assert.equal(invalidTarget.data.error.code, "REVIEW_INCIDENT_NOT_FOUND");
});

test("human accounting adjustment requires two fresh staff step-ups and never changes payment state", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(process.cwd(), env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const primary = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const approver = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.SECOND_ADMIN_PIN,
    staffName: "Demo Approver",
  });
  const created = await createInvoice(started.baseUrl, primary.token, 1000, `step-up-${Date.now()}`);
  const paid = await ingestManualPayment(started.baseUrl, primary.token, {
    invoice_id: created.data.invoice_id,
    amount_jpyc: 1000,
    chain_id: env.CHAIN_ID,
    token_contract: env.TOKEN_CONTRACT,
    to_address: env.RECIPIENT_ADDRESS,
    confirmations: 2,
    tx_hash: randomTxHash("step-up-payment"),
    log_index: 0,
    block_number: 400,
    block_timestamp: new Date(Date.now() - 1000).toISOString(),
    from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(paid.data.status, "paid");
  const reviewId = randomUUID();
  const reviewTimestamp = new Date().toISOString();
  db.prepare(`UPDATE invoices SET status = 'review_required', status_reason = 'manual_review_fixture', updated_at = ? WHERE id = ?`)
    .run(reviewTimestamp, created.data.invoice_id);
  db.prepare(
    `INSERT INTO review_cases
     (id, invoice_id, reason_type, action_history_json, status, created_at, updated_at)
     VALUES (?, ?, 'OTHER', '[]', 'open', ?, ?)`
  ).run(reviewId, created.data.invoice_id, reviewTimestamp, reviewTimestamp);
  assert.ok(reviewId);

  const invoiceBefore = db.prepare(
    `SELECT status, paid_tx_hash, paid_amount_jpyc_base, amount_jpyc_base FROM invoices WHERE id = ?`
  ).get(created.data.invoice_id);

  const withoutStepUp = await apiRequest(started.baseUrl, "/api/v1/accounting-adjustments", {
    method: "POST",
    headers: authHeaders(primary.token, {
      "content-type": "application/json",
      "idempotency-key": `adjustment-step-up-required-${Date.now()}`,
    }),
    body: JSON.stringify({
      invoice_id: created.data.invoice_id,
      review_case_id: reviewId,
      adjustment_type: "manual_acceptance",
      amount_jpyc_base: String(invoiceBefore.amount_jpyc_base),
      reason: "manual review requires accounting treatment",
      evidence: { evidence_ref: "test-evidence-before-step-up" },
    }),
  });
  assert.equal(withoutStepUp.status, 409);
  assert.equal(withoutStepUp.data.error.code, "STEP_UP_REQUIRED");

  const primaryStepUp = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions/current/step-up", {
    method: "POST",
    headers: authHeaders(primary.token, { "content-type": "application/json" }),
    body: JSON.stringify({ staff_pin: env.STAFF_PIN }),
  });
  assert.equal(primaryStepUp.status, 200);
  const approverStepUp = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions/current/step-up", {
    method: "POST",
    headers: authHeaders(approver.token, { "content-type": "application/json" }),
    body: JSON.stringify({ staff_pin: env.SECOND_ADMIN_PIN }),
  });
  assert.equal(approverStepUp.status, 200);

  const createdAdjustment = await apiRequest(started.baseUrl, "/api/v1/accounting-adjustments", {
    method: "POST",
    headers: authHeaders(primary.token, {
      "content-type": "application/json",
      "idempotency-key": `adjustment-create-${Date.now()}`,
    }),
    body: JSON.stringify({
      invoice_id: created.data.invoice_id,
      review_case_id: reviewId,
      adjustment_type: "manual_acceptance",
      amount_jpyc_base: String(invoiceBefore.amount_jpyc_base),
      reason: "manual review requires accounting treatment",
      evidence: { evidence_ref: "test-evidence-approved" },
    }),
  });
  assert.equal(createdAdjustment.status, 201, JSON.stringify(createdAdjustment.data));
  const adjustmentId = createdAdjustment.data.accounting_adjustment.id;

  const sameStaffApproval = await apiRequest(
    started.baseUrl,
    `/api/v1/accounting-adjustments/${encodeURIComponent(adjustmentId)}/approve`,
    {
      method: "POST",
      headers: authHeaders(primary.token, {
        "content-type": "application/json",
        "idempotency-key": `adjustment-same-staff-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(sameStaffApproval.status, 409);
  assert.equal(sameStaffApproval.data.error.code, "TWO_PERSON_REQUIRED");

  const approvedAdjustment = await apiRequest(
    started.baseUrl,
    `/api/v1/accounting-adjustments/${encodeURIComponent(adjustmentId)}/approve`,
    {
      method: "POST",
      headers: authHeaders(approver.token, {
        "content-type": "application/json",
        "idempotency-key": `adjustment-approve-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(approvedAdjustment.status, 200, JSON.stringify(approvedAdjustment.data));
  assert.equal(approvedAdjustment.data.accounting_adjustment.status, "approved");

  const resolved = await apiRequest(started.baseUrl, `/api/v1/reviews/${reviewId}`, {
    method: "PATCH",
    headers: authHeaders(primary.token, {
      "content-type": "application/json",
      "idempotency-key": `adjustment-review-resolve-${Date.now()}`,
    }),
    body: JSON.stringify({
      status: "resolved",
      disposition: "accounting_adjustment",
      accounting_adjustment_id: adjustmentId,
      resolution_note: "approved accounting adjustment recorded without payment recognition",
    }),
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  assert.equal(resolved.data.invoice.status, "review_required");
  assert.equal(resolved.data.invoice.paid_tx_hash, invoiceBefore.paid_tx_hash);

  const invoiceAfter = db.prepare(
    `SELECT status, paid_tx_hash, paid_amount_jpyc_base FROM invoices WHERE id = ?`
  ).get(created.data.invoice_id);
  assert.deepEqual(invoiceAfter, {
    status: invoiceBefore.status,
    paid_tx_hash: invoiceBefore.paid_tx_hash,
    paid_amount_jpyc_base: invoiceBefore.paid_amount_jpyc_base,
  });
  const journal = db.prepare(
    `SELECT event_type, status, source_ref, payload_json
     FROM accounting_event_journal
     WHERE invoice_id = ? AND event_type = 'accounting_adjustment'`
  ).get(created.data.invoice_id);
  assert.equal(journal.status, "approved");
  assert.equal(journal.source_ref, `accounting_adjustment:${adjustmentId}`);
  assert.equal(JSON.parse(journal.payload_json).invoice_transition, "none");
  const auditActions = db.prepare(
    `SELECT action FROM audit_logs WHERE target_type = 'accounting_adjustment' AND target_id = ? ORDER BY rowid`
  ).all(adjustmentId).map((row) => row.action);
  assert.deepEqual(auditActions, ["accounting_adjustment.created", "accounting_adjustment.approved"]);
});

test("all human accounting adjustment types require reason and evidence", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(process.cwd(), env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const creator = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const approver = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.SECOND_ADMIN_PIN,
    staffName: "Demo Approver",
  });
  const created = await createInvoice(started.baseUrl, creator.token, 1000, `adjustment-types-${Date.now()}`);
  assert.equal(created.status, 201);
  const invoice = db.prepare(`SELECT amount_jpyc_base, status, paid_tx_hash FROM invoices WHERE id = ?`).get(created.data.invoice_id);

  const creatorStepUp = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions/current/step-up", {
    method: "POST",
    headers: authHeaders(creator.token, { "content-type": "application/json" }),
    body: JSON.stringify({ staff_pin: env.STAFF_PIN }),
  });
  assert.equal(creatorStepUp.status, 200);
  const approverStepUp = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions/current/step-up", {
    method: "POST",
    headers: authHeaders(approver.token, { "content-type": "application/json" }),
    body: JSON.stringify({ staff_pin: env.SECOND_ADMIN_PIN }),
  });
  assert.equal(approverStepUp.status, 200);

  const invalid = await apiRequest(started.baseUrl, "/api/v1/accounting-adjustments", {
    method: "POST",
    headers: authHeaders(creator.token, {
      "content-type": "application/json",
      "idempotency-key": `adjustment-invalid-${Date.now()}`,
    }),
    body: JSON.stringify({
      invoice_id: created.data.invoice_id,
      adjustment_type: "manual_acceptance",
      amount_jpyc_base: String(invoice.amount_jpyc_base),
      reason: "short",
      evidence: {},
    }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, "VALIDATION_ERROR");

  const types = ["manual_acceptance", "loss_accepted", "goodwill", "write_off"];
  for (const adjustmentType of types) {
    const createdAdjustment = await apiRequest(started.baseUrl, "/api/v1/accounting-adjustments", {
      method: "POST",
      headers: authHeaders(creator.token, {
        "content-type": "application/json",
        "idempotency-key": `adjustment-type-${adjustmentType}-${Date.now()}`,
      }),
      body: JSON.stringify({
        invoice_id: created.data.invoice_id,
        adjustment_type: adjustmentType,
        amount_jpyc_base: String(invoice.amount_jpyc_base),
        reason: `${adjustmentType} is required for this human decision`,
        evidence: { evidence_ref: `test-${adjustmentType}` },
      }),
    });
    assert.equal(createdAdjustment.status, 201, JSON.stringify(createdAdjustment.data));
    const adjustmentId = createdAdjustment.data.accounting_adjustment.id;
    const approved = await apiRequest(
      started.baseUrl,
      `/api/v1/accounting-adjustments/${encodeURIComponent(adjustmentId)}/approve`,
      {
        method: "POST",
        headers: authHeaders(approver.token, {
          "content-type": "application/json",
          "idempotency-key": `approve-adjustment-type-${adjustmentType}-${Date.now()}`,
        }),
        body: "{}",
      }
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.accounting_adjustment.adjustment_type, adjustmentType);
    assert.equal(approved.data.invoice.status, invoice.status);
    assert.equal(approved.data.invoice.paid_tx_hash, invoice.paid_tx_hash);
  }

  const typesInDb = db.prepare(
    `SELECT adjustment_type FROM accounting_adjustments WHERE invoice_id = ? ORDER BY adjustment_type`
  ).all(created.data.invoice_id).map((row) => row.adjustment_type);
  assert.deepEqual(typesInDb, [...types].sort());
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_event_journal WHERE invoice_id = ? AND event_type = 'accounting_adjustment' AND status = 'approved'`).get(created.data.invoice_id).count,
    types.length,
  );
});
