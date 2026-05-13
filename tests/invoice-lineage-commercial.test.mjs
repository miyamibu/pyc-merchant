import test from "node:test";
import assert from "node:assert/strict";
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

test("invoice reissue creates lineage and keeps late-window monitoring on old invoice", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });

  const importPool = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
    method: "POST",
    headers: authHeaders(admin.token, {
      "content-type": "application/json",
      "idempotency-key": `lineage-pool-${Date.now()}`,
    }),
    body: JSON.stringify({
      source_label: "lineage-test",
	      addresses: [
	        { address: "0x5000000000000000000000000000000000000101", control_proof_type: "external_approval", approval_ref: "ADDR-LINEAGE-1", audit_evidence_ref: "AUDIT-LINEAGE-1" },
	        { address: "0x5000000000000000000000000000000000000102", control_proof_type: "external_approval", approval_ref: "ADDR-LINEAGE-2", audit_evidence_ref: "AUDIT-LINEAGE-2" },
	        { address: "0x5000000000000000000000000000000000000103", control_proof_type: "external_approval", approval_ref: "ADDR-LINEAGE-3", audit_evidence_ref: "AUDIT-LINEAGE-3" },
	      ],
    }),
  });
  assert.equal(importPool.status, 201);

  const first = await createInvoice(started.baseUrl, admin.token, 1500, `lineage-first-${Date.now()}`);
  assert.equal(first.status, 201);

  const firstDetail = await getInvoice(started.baseUrl, admin.token, first.data.invoice_id);
  assert.equal(firstDetail.status, 200);

  const reissue = await apiRequest(started.baseUrl, `/api/v1/invoices/${encodeURIComponent(first.data.invoice_id)}/reissue`, {
    method: "POST",
    headers: authHeaders(admin.token, {
      "content-type": "application/json",
      "idempotency-key": `lineage-reissue-${Date.now()}`,
    }),
    body: "{}",
  });
  assert.equal(reissue.status, 201);
  assert.notEqual(reissue.data.invoice_id, first.data.invoice_id);
  assert.notEqual(String(reissue.data.receive_address).toLowerCase(), String(firstDetail.data.chain.recipient_address).toLowerCase());

  const oldInvoice = await getInvoice(started.baseUrl, admin.token, first.data.invoice_id);
  assert.equal(oldInvoice.status, 200);
  assert.ok(Array.isArray(oldInvoice.data.lineage));
  assert.ok(oldInvoice.data.lineage.some((row) => row.from_invoice_id === first.data.invoice_id && row.to_invoice_id === reissue.data.invoice_id));

  const lateToOld = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: first.data.invoice_id,
      amount_jpyc: 1500,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: firstDetail.data.chain.recipient_address,
      confirmations: 2,
      tx_hash: randomTxHash("lineage-late-old"),
      from_address: "0xdddddddddddddddddddddddddddddddddddddddd",
      observed_at: new Date(Date.now() + 1000).toISOString(),
    },
    `lineage-late-${Date.now()}`
  );
  assert.equal(lateToOld.status, 200);
  assert.equal(lateToOld.data.status, "review_required");

  const oldAfter = await getInvoice(started.baseUrl, admin.token, first.data.invoice_id);
  assert.equal(oldAfter.status, 200);
  assert.equal(oldAfter.data.status, "review_required");
});
