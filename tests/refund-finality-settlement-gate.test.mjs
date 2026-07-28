import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  loginAs,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";
import { startMockRpcServer } from "./helpers/mock-rpc.mjs";

test("verified refund evidence remains a settlement blocker until finality", async (t) => {
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
  const created = await createInvoice(started.baseUrl, staff.token, 1000, `refund-finality-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(started.baseUrl, staff.token, created.data.invoice_id);
  assert.equal(detail.status, 200);
  const timestamp = new Date().toISOString();
  const reviewId = randomUUID();
  const refundId = randomUUID();
  db.prepare(
    `INSERT INTO review_cases
     (id, invoice_id, reason_type, action_history_json, resolution_status, status, created_at, updated_at, resolved_at)
     VALUES (?, ?, 'OTHER', '[]', 'settled', 'resolved', ?, ?, ?)`
  ).run(reviewId, created.data.invoice_id, timestamp, timestamp, timestamp);
  db.prepare(
    `INSERT INTO refund_requests
     (id, review_case_id, invoice_id, requested_by, status, refund_amount_jpyc, refund_amount_jpyc_base,
      refund_to_address, refund_chain_id, finality_confirmations, finality_required_confirmations,
      canonical_status, created_at, updated_at)
     VALUES (?, ?, ?, 'staff-001', 'verified', 1000, ?, ?, ?, 2, 12, 'canonical', ?, ?)`
  ).run(
    refundId,
    reviewId,
    created.data.invoice_id,
    detail.data.amounts.amount_jpyc_base,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    env.CHAIN_ID,
    timestamp,
    timestamp,
  );

  const dailyStatus = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:preview", {
    headers: authHeaders(staff.token),
  });
  assert.equal(dailyStatus.status, 200);
  const refundBlocker = (dailyStatus.data.blockers || []).find((blocker) => blocker.code === "UNRESOLVED_REFUNDS");
  assert.ok(refundBlocker, JSON.stringify(dailyStatus.data));
  assert.deepEqual(refundBlocker.refund_ids, [refundId]);
});

test("refund funding sweep revalidation reaches finalized only after accounting finality", async (t) => {
  const rpc = await startMockRpcServer({ chainId: 137 });
  const env = baseServerEnv({
    RPC_URLS: rpc.url,
    FULFILLMENT_REQUIRED_CONFIRMATIONS: "2",
    ACCOUNTING_FINALITY_CONFIRMATIONS: "4",
    REFUND_TREASURY_ADDRESS: "0xdddddddddddddddddddddddddddddddddddddddd",
    REFUND_TREASURY_APPROVAL_REF: "TREASURY-TEST-001",
  });
  const started = await startServerProcess(process.cwd(), env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
    await rpc.stop();
  });

  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const created = await createInvoice(started.baseUrl, staff.token, 1000, `refund-sweep-finality-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(started.baseUrl, staff.token, created.data.invoice_id);
  assert.equal(detail.status, 200);

  const timestamp = new Date().toISOString();
  const reviewId = randomUUID();
  const refundId = randomUUID();
  const sweepId = randomUUID();
  const sweepTxHash = randomTxHash("refund-sweep-finality");
  const refundAmountBase = String(detail.data.amounts.amount_jpyc_base);
  db.prepare(
    `UPDATE invoices
     SET status = 'review_required', paid_amount_jpyc_base = ?, paid_amount_jpyc = ?, updated_at = ?
     WHERE id = ?`
  ).run(refundAmountBase, Number(refundAmountBase) / 1_000_000, timestamp, created.data.invoice_id);
  db.prepare(
    `INSERT INTO review_cases
     (id, invoice_id, reason_type, action_history_json, resolution_status, status, created_at, updated_at)
     VALUES (?, ?, 'OTHER', '[]', 'pending', 'open', ?, ?)`
  ).run(reviewId, created.data.invoice_id, timestamp, timestamp);
  db.prepare(
    `INSERT INTO refund_requests
     (id, review_case_id, invoice_id, requested_by, status, refund_amount_jpyc, refund_amount_jpyc_base,
      refund_to_address, refund_chain_id, created_at, updated_at)
     VALUES (?, ?, ?, 'staff-001', 'approved', 1000, ?, ?, ?, ?, ?)`
  ).run(
    refundId,
    reviewId,
    created.data.invoice_id,
    refundAmountBase,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    env.CHAIN_ID,
    timestamp,
    timestamp,
  );
  db.prepare(
    `INSERT INTO refund_funding_sweeps
     (id, invoice_id, store_id, chain_id, source_address, treasury_address, sweep_tx_hash,
      sweep_amount_jpyc_base, status, canonical_status, finality_required_confirmations,
      created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recorded', 'unknown', ?, 'staff-001', ?, ?)`
  ).run(
    sweepId,
    created.data.invoice_id,
    staff.storeId,
    env.CHAIN_ID,
    detail.data.chain.recipient_address,
    env.REFUND_TREASURY_ADDRESS,
    sweepTxHash,
    refundAmountBase,
    4,
    timestamp,
    timestamp,
  );

  rpc.registerTransfer({
    txHash: sweepTxHash,
    tokenContract: env.TOKEN_CONTRACT,
    fromAddress: detail.data.chain.recipient_address,
    toAddress: env.REFUND_TREASURY_ADDRESS,
    amountBase: String(BigInt(refundAmountBase) * 10n ** 12n),
    blockNumber: 1000,
    blockTimestamp: Math.floor(Date.now() / 1000),
  });
  rpc.setLatestBlock(1001);

  const firstVerify = await apiRequest(
    started.baseUrl,
    `/api/v1/refunds/${encodeURIComponent(refundId)}/funding-lineage/verify`,
    {
      method: "POST",
      headers: authHeaders(staff.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-sweep-first-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(firstVerify.status, 409);
  assert.equal(firstVerify.data.error.code, "REFUND_FUNDING_UNDERALLOCATED");
  const verifiedSweep = db.prepare(
    `SELECT status, canonical_status, confirmations, finality_required_confirmations, finalized_at
     FROM refund_funding_sweeps WHERE id = ?`
  ).get(sweepId);
  assert.equal(verifiedSweep.status, "verified");
  assert.equal(verifiedSweep.canonical_status, "canonical");
  assert.equal(verifiedSweep.confirmations, 2);
  assert.equal(verifiedSweep.finality_required_confirmations, 4);
  assert.equal(verifiedSweep.finalized_at, null);

  rpc.setLatestBlock(1003);
  const secondVerify = await apiRequest(
    started.baseUrl,
    `/api/v1/refunds/${encodeURIComponent(refundId)}/funding-lineage/verify`,
    {
      method: "POST",
      headers: authHeaders(staff.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-sweep-second-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(secondVerify.status, 200, JSON.stringify(secondVerify.data));
  assert.equal(secondVerify.data.funding_lineage.status, "finalized");
  const finalizedSweep = db.prepare(
    `SELECT status, canonical_status, confirmations, finality_required_confirmations, finalized_at
     FROM refund_funding_sweeps WHERE id = ?`
  ).get(sweepId);
  assert.equal(finalizedSweep.status, "finalized");
  assert.equal(finalizedSweep.canonical_status, "canonical");
  assert.ok(finalizedSweep.confirmations >= 4);
  assert.equal(finalizedSweep.finality_required_confirmations, 4);
  assert.ok(finalizedSweep.finalized_at);

  // A previously finalized sweep must be revalidated on a later pass. Change
  // the canonical block hash while leaving the original receipt hash intact
  // to model a post-finality reorg.
  rpc.setCanonicalBlockHash(1000, "c");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const postFinalityReorg = await apiRequest(
    started.baseUrl,
    `/api/v1/refunds/${encodeURIComponent(refundId)}/funding-lineage/verify`,
    {
      method: "POST",
      headers: authHeaders(staff.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-sweep-post-finality-reorg-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(postFinalityReorg.status, 409, JSON.stringify(postFinalityReorg.data));
  assert.equal(postFinalityReorg.data.error.code, "REFUND_FUNDING_REORG_HOLD", JSON.stringify(postFinalityReorg.data));
  const heldSweep = db.prepare(
    `SELECT status, canonical_status, reorg_hold FROM refund_funding_sweeps WHERE id = ?`
  ).get(sweepId);
  assert.equal(heldSweep.status, "verification_failed");
  assert.equal(heldSweep.canonical_status, "unknown");
  assert.equal(heldSweep.reorg_hold, 1);
  const heldInvoice = db.prepare(
    `SELECT integrity_hold, integrity_hold_reason FROM invoices WHERE id = ?`
  ).get(created.data.invoice_id);
  assert.equal(heldInvoice.integrity_hold, 1);
  assert.equal(heldInvoice.integrity_hold_reason, "refund_chain_reorg_detected");
});
