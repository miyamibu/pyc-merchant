import test from "node:test";
import assert from "node:assert/strict";
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

const CWD = process.cwd();

async function importReceiveAddresses(baseUrl, token, count = 12, offset = 1) {
  const addresses = Array.from({ length: count }, (_value, index) =>
    `0x${String(offset + index).padStart(40, "0")}`
  );
  const res = await apiRequest(baseUrl, "/api/v1/admin/receive-addresses:import", {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `receive-import-${Date.now()}-${offset}`,
    }),
    body: JSON.stringify({ source_label: "test_pool", addresses }),
  });
  assert.equal(res.status, 201);
  return addresses;
}

async function createInvoiceDetail(baseUrl, token, amount, idemPrefix) {
  const created = await createInvoice(baseUrl, token, amount, `${idemPrefix}-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(baseUrl, token, created.data.invoice_id);
  assert.equal(detail.status, 200);
  return { created, detail };
}

async function cancelInvoice(baseUrl, token, invoiceId, idemPrefix) {
  return apiRequest(baseUrl, `/api/v1/invoices/${encodeURIComponent(invoiceId)}/cancel`, {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `${idemPrefix}-cancel-${Date.now()}`,
    }),
    body: "{}",
  });
}

async function manualIngest(baseUrl, token, invoiceId, txHash, idemPrefix) {
  return apiRequest(baseUrl, "/api/v1/payments/events:ingest", {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `${idemPrefix}-${Date.now()}`,
    }),
    body: JSON.stringify({ invoice_id: invoiceId, tx_hash: txHash }),
  });
}

async function requestRefund(baseUrl, token, reviewCaseId, amount, toAddress, chainId, idemPrefix) {
  return apiRequest(baseUrl, "/api/v1/refunds", {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `${idemPrefix}-${Date.now()}`,
    }),
    body: JSON.stringify({
      review_case_id: reviewCaseId,
      refund_amount_jpyc: amount,
      refund_to_address: toAddress,
      refund_chain_id: chainId,
    }),
  });
}

async function approveRefund(baseUrl, token, refundId, idemPrefix) {
  return apiRequest(baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/approve`, {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `${idemPrefix}-${Date.now()}`,
    }),
    body: "{}",
  });
}

async function executeRefund(baseUrl, token, refundId, txHash, idemPrefix) {
  return apiRequest(baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/execute`, {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `${idemPrefix}-${Date.now()}`,
    }),
    body: JSON.stringify({
      executor_type: "manual",
      refund_tx_hash: txHash,
    }),
  });
}

async function verifyRefund(baseUrl, token, refundId, idemKey) {
  return apiRequest(baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/verify`, {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": idemKey,
    }),
    body: "{}",
  });
}

test("manual ingest verifies receipts on-chain before applying payment decisions", async (t) => {
  const rpc = await startMockRpcServer({ chainId: 137 });
  const tokenContract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const env = baseServerEnv({
    ALLOW_MANUAL_PAYMENT_INGEST: "true",
    RPC_URLS: rpc.url,
    TOKEN_CONTRACT: tokenContract,
    APPROVED_JPYC_TOKEN_CONTRACT: tokenContract,
    TOKEN_DECIMALS: "6",
    JPYC_BASE_UNIT_SCALE: "1000000",
  });
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
    await rpc.stop();
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  await importReceiveAddresses(started.baseUrl, admin.token, 12, 10);

  await t.test("exact transfer becomes paid", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1200, "manual-paid");
    const txHash = randomTxHash("manual-paid");
    rpc.registerTransfer({
      txHash,
      tokenContract,
      fromAddress: "0x9999999999999999999999999999999999999999",
      toAddress: detail.data.chain.recipient_address,
      amountBase: detail.data.amounts.amount_jpyc_base,
      blockNumber: 100,
      blockTimestamp: Math.floor(Date.now() / 1000),
    });
    rpc.setLatestBlock(101);
    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-paid");
    assert.equal(ingest.status, 200);
    assert.equal(ingest.data.status, "paid");
  });

  await t.test("wrong token is rejected", async () => {
    const { created, detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1300, "manual-wrong-token");
    const txHash = randomTxHash("manual-wrong-token");
    rpc.registerTransfer({
      txHash,
      tokenContract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fromAddress: "0x9999999999999999999999999999999999999999",
      toAddress: detail.data.chain.recipient_address,
      amountBase: detail.data.amounts.amount_jpyc_base,
      blockNumber: 110,
    });
    rpc.setLatestBlock(112);
    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-wrong-token");
    assert.equal(ingest.status, 400);
    assert.equal(ingest.data.error.code, "WRONG_TOKEN");
    await cancelInvoice(started.baseUrl, admin.token, created.data.invoice_id, "manual-wrong-token");
  });

  await t.test("wrong recipient is rejected", async () => {
    const { created, detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1400, "manual-wrong-recipient");
    const txHash = randomTxHash("manual-wrong-recipient");
    rpc.registerTransfer({
      txHash,
      tokenContract,
      fromAddress: "0x9999999999999999999999999999999999999999",
      toAddress: "0x8888888888888888888888888888888888888888",
      amountBase: detail.data.amounts.amount_jpyc_base,
      blockNumber: 120,
    });
    rpc.setLatestBlock(122);
    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-wrong-recipient");
    assert.equal(ingest.status, 400);
    assert.equal(ingest.data.error.code, "WRONG_RECIPIENT");
    await cancelInvoice(started.baseUrl, admin.token, created.data.invoice_id, "manual-wrong-recipient");
  });

  await t.test("wrong amount routes to review_required", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1500, "manual-wrong-amount");
    const txHash = randomTxHash("manual-wrong-amount");
    rpc.registerTransfer({
      txHash,
      tokenContract,
      fromAddress: "0x9999999999999999999999999999999999999999",
      toAddress: detail.data.chain.recipient_address,
      amountBase: String(BigInt(detail.data.amounts.amount_jpyc_base) + 200_000_000n),
      blockNumber: 130,
    });
    rpc.setLatestBlock(132);
    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-wrong-amount");
    assert.equal(ingest.status, 200);
    assert.equal(ingest.data.status, "review_required");
  });

  await t.test("late payment becomes review_required", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1600, "manual-late");
    const txHash = randomTxHash("manual-late");
    const expiresAtSec = Math.floor(new Date(detail.data.expires_at).getTime() / 1000);
    rpc.registerTransfer({
      txHash,
      tokenContract,
      fromAddress: "0x9999999999999999999999999999999999999999",
      toAddress: detail.data.chain.recipient_address,
      amountBase: detail.data.amounts.amount_jpyc_base,
      blockNumber: 140,
      blockTimestamp: expiresAtSec + 30,
    });
    rpc.setLatestBlock(142);
    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-late");
    assert.equal(ingest.status, 200);
    assert.equal(ingest.data.status, "review_required");
  });

  await t.test("duplicate tx/log stays idempotent", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1700, "manual-duplicate");
    const txHash = randomTxHash("manual-duplicate");
    rpc.registerTransfer({
      txHash,
      tokenContract,
      fromAddress: "0x9999999999999999999999999999999999999999",
      toAddress: detail.data.chain.recipient_address,
      amountBase: detail.data.amounts.amount_jpyc_base,
      blockNumber: 150,
    });
    rpc.setLatestBlock(152);
    const first = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-duplicate-a");
    const second = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-duplicate-b");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.data.decision, "ignored_duplicate");
  });

  await t.test("missing receipt is rejected", async () => {
    const { created, detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1800, "manual-missing");
    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, randomTxHash("manual-missing"), "manual-missing");
    assert.equal(ingest.status, 400);
    assert.equal(ingest.data.error.code, "TX_NOT_FOUND");
    await cancelInvoice(started.baseUrl, admin.token, created.data.invoice_id, "manual-missing");
  });

  await t.test("insufficient confirmations do not succeed", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1900, "manual-pending");
    const txHash = randomTxHash("manual-pending");
    rpc.registerTransfer({
      txHash,
      tokenContract,
      fromAddress: "0x9999999999999999999999999999999999999999",
      toAddress: detail.data.chain.recipient_address,
      amountBase: detail.data.amounts.amount_jpyc_base,
      blockNumber: 160,
    });
    rpc.setLatestBlock(160);
    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-pending");
    assert.equal(ingest.status, 409);
    assert.equal(ingest.data.error.code, "CONFIRMATIONS_PENDING");
  });
});

test("manual ingest rejects wrong-chain RPC and refund verification promotes only exact confirmed transfers", async (t) => {
  const wrongChainRpc = await startMockRpcServer({ chainId: 1 });
  const tokenContract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const wrongChainEnv = baseServerEnv({
    ALLOW_MANUAL_PAYMENT_INGEST: "true",
    RPC_URLS: wrongChainRpc.url,
    TOKEN_CONTRACT: tokenContract,
    APPROVED_JPYC_TOKEN_CONTRACT: tokenContract,
    TOKEN_DECIMALS: "6",
    JPYC_BASE_UNIT_SCALE: "1000000",
  });
  const wrongChainStarted = await startServerProcess(CWD, wrongChainEnv);
  t.after(async () => {
    await stopServerProcess(wrongChainStarted.proc);
    await wrongChainRpc.stop();
  });

  const wrongChainAdmin = await loginAs(wrongChainStarted.baseUrl, {
    terminalCode: wrongChainEnv.TERMINAL_CODE,
    pin: wrongChainEnv.STAFF_PIN,
    staffName: "Demo Staff",
  });
  await importReceiveAddresses(wrongChainStarted.baseUrl, wrongChainAdmin.token, 4, 100);
  const wrongChainInvoice = await createInvoiceDetail(wrongChainStarted.baseUrl, wrongChainAdmin.token, 2100, "manual-chain");
  const wrongChainTx = randomTxHash("manual-chain");
  wrongChainRpc.registerTransfer({
    txHash: wrongChainTx,
    tokenContract,
    fromAddress: "0x9999999999999999999999999999999999999999",
    toAddress: wrongChainInvoice.detail.data.chain.recipient_address,
    amountBase: wrongChainInvoice.detail.data.amounts.amount_jpyc_base,
    blockNumber: 200,
  });
  wrongChainRpc.setLatestBlock(202);
  const wrongChainIngest = await manualIngest(
    wrongChainStarted.baseUrl,
    wrongChainAdmin.token,
    wrongChainInvoice.detail.data.invoice_id,
    wrongChainTx,
    "manual-chain"
  );
  assert.equal(wrongChainIngest.status, 400);
  assert.equal(wrongChainIngest.data.error.code, "WRONG_CHAIN");

  const rpc = await startMockRpcServer({ chainId: 137 });
  const env = baseServerEnv({
    ALLOW_MANUAL_PAYMENT_INGEST: "true",
    RPC_URLS: rpc.url,
    TOKEN_CONTRACT: tokenContract,
    APPROVED_JPYC_TOKEN_CONTRACT: tokenContract,
    TOKEN_DECIMALS: "6",
    JPYC_BASE_UNIT_SCALE: "1000000",
  });
  const started = await startServerProcess(CWD, env);
  t.after(async () => {
    await stopServerProcess(started.proc);
    await rpc.stop();
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const approver = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.SECOND_ADMIN_PIN,
    staffName: "Demo Approver",
  });
  await importReceiveAddresses(started.baseUrl, admin.token, 12, 200);

  async function createRefundScenario(label, invoiceAmount, paidAmount, refundAmount, toAddress) {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, invoiceAmount, `${label}-invoice`);
    const paymentTx = randomTxHash(`${label}-payment`);
    rpc.registerTransfer({
      txHash: paymentTx,
      tokenContract,
      fromAddress: "0x9999999999999999999999999999999999999999",
      toAddress: detail.data.chain.recipient_address,
      amountBase: String(BigInt(detail.data.amounts.amount_jpyc_base) + BigInt(paidAmount - invoiceAmount) * 1_000_000n),
      blockNumber: 300 + Math.floor(Math.random() * 100),
    });
    rpc.setLatestBlock(500);
    const paid = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, paymentTx, `${label}-ingest`);
    assert.equal(paid.status, 200);
    assert.equal(paid.data.status, "review_required");
    const refreshed = await getInvoice(started.baseUrl, admin.token, detail.data.invoice_id);
    const request = await requestRefund(started.baseUrl, admin.token, refreshed.data.review_case_id, refundAmount, toAddress, env.CHAIN_ID, `${label}-request`);
    assert.equal(request.status, 201);
    const approve = await approveRefund(started.baseUrl, approver.token, request.data.refund_request_id, `${label}-approve`);
    assert.equal(approve.status, 200);
    return {
      refundId: request.data.refund_request_id,
      invoice: refreshed.data,
      refundToAddress: toAddress,
      refundAmountBase: request.data.refund_amount_jpyc_base,
    };
  }

  await t.test("recorded refund is promoted to succeeded after exact on-chain verification", async () => {
    const scenario = await createRefundScenario("refund-success", 2200, 2400, 200, "0x4444444444444444444444444444444444444444");
    const refundTx = randomTxHash("refund-success");
    const execute = await executeRefund(started.baseUrl, admin.token, scenario.refundId, refundTx, "refund-success-execute");
    assert.equal(execute.status, 200);
    assert.equal(execute.data.status, "recorded");
    rpc.registerTransfer({
      txHash: refundTx,
      tokenContract,
      fromAddress: scenario.invoice.chain.recipient_address,
      toAddress: scenario.refundToAddress,
      amountBase: scenario.refundAmountBase,
      blockNumber: 600,
    });
    rpc.setLatestBlock(602);
    const idem = `refund-success-verify-${Date.now()}`;
    const verify = await verifyRefund(started.baseUrl, admin.token, scenario.refundId, idem);
    const verifyReplay = await verifyRefund(started.baseUrl, admin.token, scenario.refundId, idem);
    assert.equal(verify.status, 200);
    assert.equal(verify.data.status, "succeeded");
    assert.equal(verifyReplay.status, 200);
    assert.equal(verifyReplay.data.status, "succeeded");
  });

  await t.test("mismatched refund transfer does not succeed", async () => {
    const wrongToken = await createRefundScenario("refund-wrong-token", 2300, 2500, 200, "0x5555555555555555555555555555555555555555");
    const wrongTokenTx = randomTxHash("refund-wrong-token");
    await executeRefund(started.baseUrl, admin.token, wrongToken.refundId, wrongTokenTx, "refund-wrong-token-execute");
    rpc.registerTransfer({
      txHash: wrongTokenTx,
      tokenContract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fromAddress: wrongToken.invoice.chain.recipient_address,
      toAddress: wrongToken.refundToAddress,
      amountBase: wrongToken.refundAmountBase,
      blockNumber: 610,
    });
    rpc.setLatestBlock(612);
    const verifyWrongToken = await verifyRefund(started.baseUrl, admin.token, wrongToken.refundId, `refund-wrong-token-verify-${Date.now()}`);
    assert.equal(verifyWrongToken.status, 200);
    assert.equal(verifyWrongToken.data.status, "verification_failed");

    const wrongTo = await createRefundScenario("refund-wrong-to", 2400, 2600, 200, "0x6666666666666666666666666666666666666666");
    const wrongToTx = randomTxHash("refund-wrong-to");
    await executeRefund(started.baseUrl, admin.token, wrongTo.refundId, wrongToTx, "refund-wrong-to-execute");
    rpc.registerTransfer({
      txHash: wrongToTx,
      tokenContract,
      fromAddress: wrongTo.invoice.chain.recipient_address,
      toAddress: "0x7777777777777777777777777777777777777777",
      amountBase: wrongTo.refundAmountBase,
      blockNumber: 620,
    });
    rpc.setLatestBlock(622);
    const verifyWrongTo = await verifyRefund(started.baseUrl, admin.token, wrongTo.refundId, `refund-wrong-to-verify-${Date.now()}`);
    assert.equal(verifyWrongTo.status, 200);
    assert.equal(verifyWrongTo.data.status, "verification_failed");

    const wrongFrom = await createRefundScenario("refund-wrong-from", 2500, 2700, 200, "0x8888888888888888888888888888888888888888");
    const wrongFromTx = randomTxHash("refund-wrong-from");
    await executeRefund(started.baseUrl, admin.token, wrongFrom.refundId, wrongFromTx, "refund-wrong-from-execute");
    rpc.registerTransfer({
      txHash: wrongFromTx,
      tokenContract,
      fromAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      toAddress: wrongFrom.refundToAddress,
      amountBase: wrongFrom.refundAmountBase,
      blockNumber: 630,
    });
    rpc.setLatestBlock(632);
    const verifyWrongFrom = await verifyRefund(started.baseUrl, admin.token, wrongFrom.refundId, `refund-wrong-from-verify-${Date.now()}`);
    assert.equal(verifyWrongFrom.status, 200);
    assert.equal(verifyWrongFrom.data.status, "verification_failed");

    const wrongAmount = await createRefundScenario("refund-wrong-amount", 2600, 2800, 200, "0x9999999999999999999999999999999999999999");
    const wrongAmountTx = randomTxHash("refund-wrong-amount");
    await executeRefund(started.baseUrl, admin.token, wrongAmount.refundId, wrongAmountTx, "refund-wrong-amount-execute");
    rpc.registerTransfer({
      txHash: wrongAmountTx,
      tokenContract,
      fromAddress: wrongAmount.invoice.chain.recipient_address,
      toAddress: wrongAmount.refundToAddress,
      amountBase: String(BigInt(wrongAmount.refundAmountBase) + 1_000_000n),
      blockNumber: 640,
    });
    rpc.setLatestBlock(642);
    const verifyWrongAmount = await verifyRefund(started.baseUrl, admin.token, wrongAmount.refundId, `refund-wrong-amount-verify-${Date.now()}`);
    assert.equal(verifyWrongAmount.status, 200);
    assert.equal(verifyWrongAmount.data.status, "verification_failed");
  });

  await t.test("refund verification stays pending when confirmations are insufficient", async () => {
    const pending = await createRefundScenario("refund-pending", 2700, 2900, 200, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const pendingTx = randomTxHash("refund-pending");
    await executeRefund(started.baseUrl, admin.token, pending.refundId, pendingTx, "refund-pending-execute");
    rpc.registerTransfer({
      txHash: pendingTx,
      tokenContract,
      fromAddress: pending.invoice.chain.recipient_address,
      toAddress: pending.refundToAddress,
      amountBase: pending.refundAmountBase,
      blockNumber: 650,
    });
    rpc.setLatestBlock(650);
    const verifyPending = await verifyRefund(started.baseUrl, admin.token, pending.refundId, `refund-pending-verify-${Date.now()}`);
    assert.equal(verifyPending.status, 200);
    assert.equal(verifyPending.data.status, "pending_verification");
  });

  await t.test("refund verification is audited", async () => {
    const auditLogs = await apiRequest(started.baseUrl, "/api/v1/audit-logs?limit=400", {
      headers: authHeaders(admin.token),
    });
    assert.equal(auditLogs.status, 200);
    const actions = (auditLogs.data.audit_logs || []).map((row) => row.action);
    assert.ok(actions.includes("refund.verified_onchain"));
  });
});
