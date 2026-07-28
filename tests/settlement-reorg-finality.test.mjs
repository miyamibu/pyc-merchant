import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  loginAs,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";
import { startMockRpcServer } from "./helpers/mock-rpc.mjs";

test("chain reorg resolution requires canonical revalidation evidence and settlement blocks unverified resolution", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(process.cwd(), env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const storeAdmin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const created = await createInvoice(started.baseUrl, storeAdmin.token, 1000, `reorg-evidence-${Date.now()}`);
  assert.equal(created.status, 201);

  const detectedAt = new Date().toISOString();
  const reorgId = randomUUID();
  db.prepare(
    `INSERT INTO chain_reorgs
     (id, chain_id, from_block, to_block, previous_checkpoint_hash, observed_checkpoint_hash,
      reason, status, detected_at)
     VALUES (?, ?, 700, 701, ?, ?, 'checkpoint_mismatch', 'unresolved', ?)`
  ).run(reorgId, env.CHAIN_ID, "0xprevious", "0xobserved", detectedAt);

  // The resolve route is intentionally platform-scoped. Promote only this
  // isolated test fixture so the test exercises the real permission boundary.
  db.prepare("UPDATE staff_users SET role = 'platform_ops', updated_at = ? WHERE id = 'staff-002'").run(detectedAt);
  const platformOperator = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.SECOND_ADMIN_PIN,
    staffName: "Demo Approver",
  });

  const resolve = (body, idempotencyKey) => apiRequest(
    started.baseUrl,
    `/api/v1/chain-monitor/reorgs/${encodeURIComponent(reorgId)}/resolve`,
    {
      method: "POST",
      headers: authHeaders(platformOperator.token, {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      }),
      body: JSON.stringify(body),
    }
  );

  const missingEvidence = await resolve(
    { resolution_note: "reconcile without evidence", invoice_ids: [] },
    `reorg-missing-${Date.now()}`
  );
  assert.equal(missingEvidence.status, 409);
  assert.equal(missingEvidence.data.error.code, "REORG_REVALIDATION_EVIDENCE_REQUIRED");
  assert.equal(db.prepare(`SELECT status FROM chain_reorgs WHERE id = ?`).get(reorgId).status, "unresolved");

  const mismatchedEvidence = await resolve(
    {
      resolution_note: "reconcile with mismatched block range",
      invoice_ids: [],
      canonical_revalidation: {
        block_range: { from_block: 700, to_block: 702 },
        canonical_hash: "0xcanonical-1",
        canonical_status: "canonical",
        rechecked_at: new Date().toISOString(),
        reconciliation_reference: "recon-mismatch-1",
        affected_invoices: [],
      },
    },
    `reorg-mismatch-${Date.now()}`
  );
  assert.equal(mismatchedEvidence.status, 409);
  assert.equal(mismatchedEvidence.data.error.code, "REORG_REVALIDATION_EVIDENCE_INVALID");
  assert.equal(db.prepare(`SELECT status FROM chain_reorgs WHERE id = ?`).get(reorgId).status, "unresolved");

  const validEvidence = await resolve(
    {
      resolution_note: "canonical block range rechecked and reconciled",
      invoice_ids: [],
      canonical_revalidation: {
        block_range: { from_block: 700, to_block: 701 },
        canonical_hash: "0xcanonical-1",
        canonical_status: "canonical",
        rechecked_at: new Date().toISOString(),
        reconciliation_reference: "recon-valid-1",
        affected_invoices: [],
      },
    },
    `reorg-valid-${Date.now()}`
  );
  assert.equal(validEvidence.status, 200, JSON.stringify(validEvidence.data));
  assert.equal(validEvidence.data.reorg.status, "resolved");
  assert.equal(validEvidence.data.reorg.revalidation_status, "verified");
  assert.equal(validEvidence.data.revalidated_evidence.canonical_status, "canonical");

  const unresolvedRevalidationId = randomUUID();
  db.prepare(
    `INSERT INTO chain_reorgs
     (id, chain_id, from_block, to_block, previous_checkpoint_hash, observed_checkpoint_hash,
      reason, status, detected_at, revalidation_status)
     VALUES (?, ?, 800, 801, ?, ?, 'checkpoint_mismatch_2', 'resolved', ?, 'unverified')`
  ).run(unresolvedRevalidationId, env.CHAIN_ID, "0xprevious-2", "0xobserved-2", detectedAt);

  const dailyPreview = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:preview", {
    headers: authHeaders(storeAdmin.token),
  });
  assert.equal(dailyPreview.status, 200);
  const revalidationBlocker = (dailyPreview.data.blockers || []).find(
    (blocker) => blocker.code === "UNVERIFIED_CHAIN_REORG_REVALIDATION"
  );
  assert.ok(revalidationBlocker, JSON.stringify(dailyPreview.data));
  assert.deepEqual(revalidationBlocker.reorg_ids, [unresolvedRevalidationId]);
});

test("production-like reorg resolution binds evidence to a server-side RPC attestation", async (t) => {
  const rpc = await startMockRpcServer({ chainId: 137 });
  const canonicalTxHash = randomTxHash("reorg-rpc-attestation");
  rpc.registerTransfer({
    txHash: canonicalTxHash,
    tokenContract: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
    fromAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    toAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    amountBase: "1000000000000000000",
    blockNumber: 701,
  });
  const env = baseServerEnv({ RPC_URLS: rpc.url });
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
  const created = await createInvoice(started.baseUrl, staff.token, 1000, `reorg-rpc-${Date.now()}`);
  assert.equal(created.status, 201);
  const detectedAt = new Date().toISOString();
  const reorgId = randomUUID();
  db.prepare(
    `INSERT INTO chain_reorgs
     (id, chain_id, from_block, to_block, previous_checkpoint_hash, observed_checkpoint_hash,
      reason, status, detected_at)
     VALUES (?, ?, 700, 701, ?, ?, 'checkpoint_hash_mismatch', 'unresolved', ?)`
  ).run(reorgId, env.CHAIN_ID, "0xprevious", "0xobserved", detectedAt);
  db.prepare("UPDATE staff_users SET role = 'platform_ops', updated_at = ? WHERE id = 'staff-002'").run(detectedAt);
  const operator = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.SECOND_ADMIN_PIN,
    staffName: "Demo Approver",
  });
  const resolved = await apiRequest(
    started.baseUrl,
    `/api/v1/chain-monitor/reorgs/${encodeURIComponent(reorgId)}/resolve`,
    {
      method: "POST",
      headers: authHeaders(operator.token, {
        "content-type": "application/json",
        "idempotency-key": `reorg-rpc-attestation-${Date.now()}`,
      }),
      body: JSON.stringify({
        resolution_note: "server RPC canonical block rechecked",
        invoice_ids: [],
        canonical_revalidation: {
          block_range: { from_block: 700, to_block: 701 },
          canonical_hash: rpc.getBlockHash(701),
          canonical_status: "canonical",
          rechecked_at: new Date().toISOString(),
          reconciliation_reference: "rpc-attestation-test",
          affected_invoices: [],
        },
      }),
    }
  );
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  assert.equal(resolved.data.revalidated_evidence.rpc_attestation.rpc_verified, true);
  assert.equal(resolved.data.revalidated_evidence.rpc_attestation.canonical_checkpoint_number, 701);
});
