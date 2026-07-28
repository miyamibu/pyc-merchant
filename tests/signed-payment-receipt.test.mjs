import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  ingestManualPayment,
  loginAs,
  randomTxHash,
  parsePaymentUrl,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

test("public paid invoice exposes and audits a server-signed payment receipt", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(process.cwd(), env);
  t.after(async () => stopServerProcess(started.proc));
  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const created = await createInvoice(started.baseUrl, staff.token, 1000, `signed-receipt-${Date.now()}`);
  assert.equal(created.status, 201);
  const paid = await ingestManualPayment(started.baseUrl, staff.token, {
    invoice_id: created.data.invoice_id,
    amount_jpyc: 1000,
    chain_id: env.CHAIN_ID,
    token_contract: env.TOKEN_CONTRACT,
    to_address: env.RECIPIENT_ADDRESS,
    confirmations: 2,
    tx_hash: randomTxHash("signed-receipt"),
    log_index: 0,
    block_number: 400,
    block_timestamp: new Date(Date.now() - 1000).toISOString(),
    from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, "paid");

  const signed = parsePaymentUrl(created.data.payment_url);
  const publicQuery = `sig=${encodeURIComponent(signed.sig)}&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`;
  const publicPath = `/api/v1/public/invoices/${encodeURIComponent(created.data.invoice_id)}?${publicQuery}`;
  const publicInvoice = await apiRequest(started.baseUrl, publicPath);
  assert.equal(publicInvoice.status, 200);
  assert.equal(publicInvoice.data.receipt_status, "issued");
  const receipt = publicInvoice.data.receipt;
  assert.equal(receipt.receipt_version, "payment_receipt_v1");
  assert.equal(receipt.invoice_id, created.data.invoice_id);
  assert.equal(receipt.chain_id, env.CHAIN_ID);
  assert.equal(receipt.log_index, 0);
  assert.equal(receipt.integrity_status, "ok");
  assert.equal(receipt.signature_algorithm, "HMAC-SHA256");
  assert.equal(
    receipt.signature,
    createHmac("sha256", env.APP_SECRET).update(receipt.signed_message).digest("hex")
  );
  const { content_sha256, signature, kid, signature_algorithm, signed_message, ...content } = receipt;
  assert.equal(content_sha256, createHash("sha256").update(JSON.stringify(content)).digest("hex"));
  assert.equal(signed_message, `${kid}.${content_sha256}`);
  assert.equal(signature.length, 64);

  const receiptEndpoint = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(created.data.invoice_id)}/receipt?${publicQuery}`
  );
  assert.equal(receiptEndpoint.status, 200);
  assert.deepEqual(receiptEndpoint.data.receipt, receipt);

  const verifiedReceipt = await apiRequest(started.baseUrl, "/api/v1/public/payment-receipts/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receipt }),
  });
  assert.equal(verifiedReceipt.status, 200);
  assert.equal(verifiedReceipt.data.valid, true);
  assert.equal(verifiedReceipt.data.status, "valid");
  assert.ok(verifiedReceipt.data.receipt_id);

  const audit = await apiRequest(
    started.baseUrl,
    `/api/v1/audit-logs?target_type=invoice&target_id=${encodeURIComponent(created.data.invoice_id)}&limit=100`,
    { headers: authHeaders(staff.token) }
  );
  assert.equal(audit.status, 200);
  assert.ok((audit.data.audit_logs || []).some((row) => row.action === "receipt.issued"));
});
