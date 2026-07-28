import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import {
  apiRequest,
  baseServerEnv,
  createInvoice,
  getInvoice,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";
import { buildServiceAuthHeaders } from "./helpers/service-auth.mjs";

test("chain reconciliation financial writes are accepted only by the signed API writer", async (t) => {
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
  const created = await createInvoice(started.baseUrl, staff.token, 1000, `writer-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(started.baseUrl, staff.token, created.data.invoice_id);
  assert.equal(detail.status, 200);
  const recipient = detail.data.chain.recipient_address;
  const payload = {
    schema_version: 1,
    source: "chain_monitor",
    chain_id: env.CHAIN_ID,
    token_contract: env.TOKEN_CONTRACT.toLowerCase(),
    block_number: 12345,
    reconciled_at: new Date().toISOString(),
    invoices: [{ invoice_id: created.data.invoice_id, recipient_address: recipient }],
  };
  const idempotencyKey = `chain-reconciliation-test-${Date.now()}`;
  const written = await apiRequest(started.baseUrl, "/api/v1/internal/chain/reconciliation:ingest", {
    method: "POST",
    headers: buildServiceAuthHeaders(env, payload, idempotencyKey),
    body: JSON.stringify(payload),
  });
  assert.equal(written.status, 200, JSON.stringify(written.data));
  assert.equal(written.data.financial_writer, "api-server");
  assert.equal(
    db.prepare("SELECT last_reconciled_block FROM invoices WHERE id = ?").get(created.data.invoice_id).last_reconciled_block,
    12345,
  );

  const mismatched = {
    ...payload,
    invoices: [{ invoice_id: created.data.invoice_id, recipient_address: "0x3333333333333333333333333333333333333333" }],
  };
  const mismatchKey = `chain-reconciliation-mismatch-${Date.now()}`;
  const rejected = await apiRequest(started.baseUrl, "/api/v1/internal/chain/reconciliation:ingest", {
    method: "POST",
    headers: buildServiceAuthHeaders(env, mismatched, mismatchKey),
    body: JSON.stringify(mismatched),
  });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
  assert.equal(rejected.data.error.code, "RECONCILIATION_INVOICE_EVIDENCE_MISMATCH");

  const reorgPayload = {
    chain_id: env.CHAIN_ID,
    reorg_id: randomUUID(),
    from_block: 500,
    to_block: 501,
    previous_hash: `0x${"a".repeat(64)}`,
    observed_hash: `0x${"b".repeat(64)}`,
    reason: "checkpoint_hash_mismatch",
    detected_at: new Date().toISOString(),
  };
  const reorgKey = `chain-reorg-writer-${Date.now()}`;
  const reorg = await apiRequest(started.baseUrl, "/api/v1/internal/chain/reorgs:ingest", {
    method: "POST",
    headers: buildServiceAuthHeaders(env, reorgPayload, reorgKey),
    body: JSON.stringify(reorgPayload),
  });
  assert.equal(reorg.status, 200, JSON.stringify(reorg.data));
  assert.equal(reorg.data.financial_writer, "api-server");
  assert.equal(reorg.data.reorg_id, reorgPayload.reorg_id);
  assert.equal(
    db.prepare("SELECT status, from_block, to_block FROM chain_reorgs WHERE id = ?").get(reorgPayload.reorg_id).status,
    "unresolved",
  );

  const eventId = randomUUID();
  const eventTxHash = `0x${"c".repeat(64)}`;
  const eventTimestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO payment_events
     (id, invoice_id, event_type, chain_id, tx_hash, log_index, block_number, confirmations,
      from_address, to_address, token_contract, amount_jpyc, amount_jpyc_base, canonical_status,
      recognition_status, observed_at, block_hash, block_timestamp, detected_at, raw_payload, created_at)
     VALUES (?, ?, 'tx_detected', ?, ?, 0, 500, 2, ?, ?, ?, 1000, ?, 'canonical', 'eligible', ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    created.data.invoice_id,
    env.CHAIN_ID,
    eventTxHash,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    recipient,
    env.TOKEN_CONTRACT.toLowerCase(),
    detail.data.amounts.amount_jpyc_base,
    eventTimestamp,
    `0x${"d".repeat(64)}`,
    eventTimestamp,
    eventTimestamp,
    JSON.stringify({ invoice_id: created.data.invoice_id, tx_hash: eventTxHash }),
    eventTimestamp,
  );
  db.prepare("UPDATE invoices SET status = 'paid', paid_amount_jpyc = 1000, paid_amount_jpyc_base = ?, paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(detail.data.amounts.amount_jpyc_base, eventTxHash, eventTimestamp, created.data.invoice_id);
  const affectedReorgPayload = {
    ...reorgPayload,
    reorg_id: randomUUID(),
    from_block: 500,
    to_block: 501,
    previous_hash: `0x${"e".repeat(64)}`,
    observed_hash: `0x${"f".repeat(64)}`,
  };
  const affectedReorgKey = `chain-reorg-affected-${Date.now()}`;
  const affectedReorg = await apiRequest(started.baseUrl, "/api/v1/internal/chain/reorgs:ingest", {
    method: "POST",
    headers: buildServiceAuthHeaders(env, affectedReorgPayload, affectedReorgKey),
    body: JSON.stringify(affectedReorgPayload),
  });
  assert.equal(affectedReorg.status, 200, JSON.stringify(affectedReorg.data));
  assert.deepEqual(affectedReorg.data.affected_invoice_ids, [created.data.invoice_id]);
  assert.equal(db.prepare("SELECT integrity_hold FROM invoices WHERE id = ?").get(created.data.invoice_id).integrity_hold, 1);
  const eventAfterReorg = db.prepare("SELECT canonical_status, recognition_status, reorg_id FROM payment_events WHERE id = ?").get(eventId);
  assert.equal(eventAfterReorg.canonical_status, "disputed");
  assert.equal(eventAfterReorg.recognition_status, "review_required");
  assert.equal(eventAfterReorg.reorg_id, affectedReorgPayload.reorg_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payment_notification_outbox WHERE invoice_id = ? AND notification_type = 'payment_review'").get(created.data.invoice_id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'chain_reorg.detected' AND target_id = ?").get(affectedReorgPayload.reorg_id).count, 1);
});
