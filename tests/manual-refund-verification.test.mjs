import test from "node:test";
import assert from "node:assert/strict";
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

async function verifyRefund(baseUrl, token, refundId, idemKey, refundTxHash = null) {
  return apiRequest(baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/verify`, {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": idemKey,
    }),
    body: JSON.stringify(refundTxHash ? { refund_tx_hash: refundTxHash } : {}),
  });
}

async function recordRefundFundingLineage(baseUrl, token, refundId, payload, idemPrefix) {
  return apiRequest(baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/funding-lineage`, {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `${idemPrefix}-${Date.now()}`,
    }),
    body: JSON.stringify(payload),
  });
}

async function verifyRefundFundingLineage(baseUrl, token, refundId, idemPrefix) {
  return apiRequest(baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/funding-lineage/verify`, {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `${idemPrefix}-${Date.now()}`,
    }),
    body: "{}",
  });
}

function holdNextReceiptResponse(rpc, txHash) {
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  let releaseResponse;
  const releasePromise = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  let held = false;
  rpc.setBeforeRespond(async ({ method, payload }) => {
    if (
      !held
      && method === "eth_getTransactionReceipt"
      && String(payload.params?.[0] || "").toLowerCase() === txHash.toLowerCase()
    ) {
      held = true;
      markEntered();
      await releasePromise;
    }
  });
  return {
    entered,
    release() {
      releaseResponse();
      rpc.setBeforeRespond(null);
    },
  };
}

async function waitForReceiptHold(hold) {
  await Promise.race([
    hold.entered,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("refund verification did not reach RPC")), 3000)),
  ]);
}

async function waitForPendingIdempotencyClaim(db, idempotencyKey) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = db
      .prepare(`SELECT status_code FROM idempotency_records WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1`)
      .get(idempotencyKey);
    if (row?.status_code === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`pending idempotency claim was not observed for ${idempotencyKey}`);
}

test("manual ingest verifies receipts on-chain before applying payment decisions", async (t) => {
  const rpc = await startMockRpcServer({ chainId: 137 });
  const tokenContract = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
  const env = baseServerEnv({
    ALLOW_MANUAL_PAYMENT_INGEST: "true",
    RPC_URLS: rpc.url,
    TOKEN_CONTRACT: tokenContract,
    APPROVED_JPYC_TOKEN_CONTRACT: tokenContract,
    TOKEN_DECIMALS: "6",
    JPYC_BASE_UNIT_SCALE: "1000000",
    REFUND_TREASURY_ADDRESS: "0xdddddddddddddddddddddddddddddddddddddddd",
    REFUND_TREASURY_APPROVAL_REF: "TREASURY-2026-001",
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

  await t.test("multiple matching transfers become an invoice-linked integrity review", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1550, "manual-multiple-transfers");
    const txHash = randomTxHash("manual-multiple-transfers");
    rpc.registerTransfer({
      txHash,
      tokenContract,
      fromAddress: "0x9999999999999999999999999999999999999999",
      toAddress: detail.data.chain.recipient_address,
      amountBase: detail.data.amounts.amount_jpyc_base,
      additionalTransfers: [{
        fromAddress: "0x9999999999999999999999999999999999999999",
        toAddress: detail.data.chain.recipient_address,
        amountBase: "1",
        logIndex: 1,
      }],
      blockNumber: 135,
    });
    rpc.setLatestBlock(137);
    const ingest = await manualIngest(
      started.baseUrl,
      admin.token,
      detail.data.invoice_id,
      txHash,
      "manual-multiple-transfers"
    );
    assert.equal(ingest.status, 200);
    assert.equal(ingest.data.status, "review_required");
    assert.equal(ingest.data.decision, "review_required");
    const invoice = await getInvoice(started.baseUrl, admin.token, detail.data.invoice_id);
    assert.equal(invoice.data.status, "review_required");
    assert.equal(invoice.data.status_reason, "multiple_matching_transfers");
    const event = new Database(env.DB_PATH, { readonly: true });
    try {
      const paymentEvent = event
        .prepare(`SELECT invoice_id, amount_jpyc_base, amount_atomic, recognition_status, raw_payload FROM payment_events WHERE tx_hash = ?`)
        .get(txHash);
      assert.equal(paymentEvent.invoice_id, detail.data.invoice_id);
      assert.equal(
        paymentEvent.amount_atomic,
        (BigInt(detail.data.amounts.amount_jpyc_base) + 1n).toString()
      );
      assert.equal(String(paymentEvent.amount_jpyc_base), paymentEvent.amount_atomic);
      assert.equal(paymentEvent.recognition_status, "review_required");
      const rawPayload = JSON.parse(paymentEvent.raw_payload);
      assert.equal(rawPayload.chain_inconsistency_reason, "multiple_matching_transfers");
      assert.equal(rawPayload.matching_transfers.length, 2);
      const heldInvoice = event
        .prepare(`SELECT integrity_hold, integrity_hold_reason FROM invoices WHERE id = ?`)
        .get(detail.data.invoice_id);
      assert.equal(Number(heldInvoice.integrity_hold), 1);
      assert.equal(heldInvoice.integrity_hold_reason, "multiple_matching_transfers");
      const review = event
        .prepare(`SELECT reason_type FROM review_cases WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(detail.data.invoice_id);
      assert.equal(review.reason_type, "CHAIN_INCONSISTENT");
    } finally {
      event.close();
    }
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
  const tokenContract = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
  const wrongChainEnv = baseServerEnv({
    ALLOW_MANUAL_PAYMENT_INGEST: "true",
    RPC_URLS: wrongChainRpc.url,
    TOKEN_CONTRACT: tokenContract,
    APPROVED_JPYC_TOKEN_CONTRACT: tokenContract,
    TOKEN_DECIMALS: "6",
    JPYC_BASE_UNIT_SCALE: "1000000",
    REFUND_TREASURY_ADDRESS: "0xdddddddddddddddddddddddddddddddddddddddd",
    REFUND_TREASURY_APPROVAL_REF: "TREASURY-2026-001",
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
    REFUND_TREASURY_ADDRESS: "0xdddddddddddddddddddddddddddddddddddddddd",
    REFUND_TREASURY_APPROVAL_REF: "TREASURY-2026-001",
  });
  const started = await startServerProcess(CWD, env);
  const testDb = new Database(env.DB_PATH, { readonly: true });
  t.after(async () => {
    testDb.close();
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
      fromAddress: toAddress,
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
      payerAddress: toAddress,
      refundToAddress: toAddress,
      refundAmountBase: request.data.refund_amount_jpyc_base,
    };
  }

  await t.test("refund funding lineage is recorded, verified, and permits treasury-origin refund verification", async () => {
    const scenario = await createRefundScenario("refund-funding-lineage", 2205, 2405, 200, "0x4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d");
    const treasuryAddress = env.REFUND_TREASURY_ADDRESS;
    const sweepTx = randomTxHash("refund-funding-sweep");
    const sweepAmountBase = scenario.refundAmountBase;
    const sourceAddress = scenario.invoice.chain.recipient_address;
    rpc.registerTransfer({
      txHash: sweepTx,
      tokenContract,
      fromAddress: sourceAddress,
      toAddress: treasuryAddress,
      amountBase: sweepAmountBase,
      blockNumber: 700,
    });
    rpc.setLatestBlock(702);

    const recorded = await recordRefundFundingLineage(
      started.baseUrl,
      admin.token,
      scenario.refundId,
      {
        source_address: sourceAddress,
        treasury_address: treasuryAddress,
        chain_id: env.CHAIN_ID,
        sweep_tx_hash: sweepTx,
        sweep_amount_jpyc_base: sweepAmountBase,
      },
      "refund-funding-record"
    );
    assert.equal(recorded.status, 201);
    assert.equal(recorded.data.funding_lineage.status, "recorded");

    const verifiedLineage = await verifyRefundFundingLineage(
      started.baseUrl,
      admin.token,
      scenario.refundId,
      "refund-funding-verify"
    );
    assert.equal(verifiedLineage.status, 200);
    assert.equal(verifiedLineage.data.funding_lineage.status, "verified");

    const refundTx = randomTxHash("refund-funding-treasury");
    const executed = await executeRefund(started.baseUrl, admin.token, scenario.refundId, refundTx, "refund-funding-execute");
    assert.equal(executed.status, 200);
    rpc.registerTransfer({
      txHash: refundTx,
      tokenContract,
      fromAddress: treasuryAddress,
      toAddress: scenario.refundToAddress,
      amountBase: scenario.refundAmountBase,
      blockNumber: 800,
    });
    rpc.setLatestBlock(802);
    const refundVerified = await verifyRefund(
      started.baseUrl,
      admin.token,
      scenario.refundId,
      `refund-funding-refund-verify-${Date.now()}`
    );
    assert.equal(refundVerified.status, 200);
    assert.equal(refundVerified.data.status, "succeeded");
  });

  await t.test("one verified funding sweep cannot be reused across refunds", async () => {
    const label = `refund-funding-conservation-${Date.now()}`;
    const payerAddress = "0x4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e";
    const treasuryAddress = env.REFUND_TREASURY_ADDRESS;
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 2300, `${label}-invoice`);
    const paymentTx = randomTxHash(`payment-${label}`);
    rpc.registerTransfer({
      txHash: paymentTx,
      tokenContract,
      fromAddress: payerAddress,
      toAddress: detail.data.chain.recipient_address,
      amountBase: String(BigInt(detail.data.amounts.amount_jpyc_base) + 300_000_000n),
      blockNumber: 705,
    });
    rpc.setLatestBlock(707);
    const paid = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, paymentTx, `${label}-ingest`);
    assert.equal(paid.status, 200);
    assert.equal(paid.data.status, "review_required");
    const refreshed = await getInvoice(started.baseUrl, admin.token, detail.data.invoice_id);

    const firstRequest = await requestRefund(
      started.baseUrl,
      admin.token,
      refreshed.data.review_case_id,
      200,
      payerAddress,
      env.CHAIN_ID,
      `${label}-first-request`
    );
    const secondRequest = await requestRefund(
      started.baseUrl,
      admin.token,
      refreshed.data.review_case_id,
      100,
      payerAddress,
      env.CHAIN_ID,
      `${label}-second-request`
    );
    assert.equal(firstRequest.status, 201);
    assert.equal(secondRequest.status, 201);
    for (const [refundId, suffix] of [
      [firstRequest.data.refund_request_id, "first"],
      [secondRequest.data.refund_request_id, "second"],
    ]) {
      const approved = await approveRefund(started.baseUrl, approver.token, refundId, `${label}-${suffix}-approve`);
      assert.equal(approved.status, 200);
    }

    const sweepTx = randomTxHash(`sweep-${label}`);
    rpc.registerTransfer({
      txHash: sweepTx,
      tokenContract,
      fromAddress: detail.data.chain.recipient_address,
      toAddress: treasuryAddress,
      amountBase: firstRequest.data.refund_amount_jpyc_base,
      blockNumber: 710,
    });
    rpc.setLatestBlock(712);
    const recorded = await recordRefundFundingLineage(
      started.baseUrl,
      admin.token,
      firstRequest.data.refund_request_id,
      {
        source_address: detail.data.chain.recipient_address,
        treasury_address: treasuryAddress,
        chain_id: env.CHAIN_ID,
        sweep_tx_hash: sweepTx,
        sweep_amount_jpyc_base: firstRequest.data.refund_amount_jpyc_base,
      },
      `${label}-record`
    );
    assert.equal(recorded.status, 201);
    const legacyFundingLink = testDb
      .prepare(`SELECT funding_lineage_id FROM refund_requests WHERE id = ?`)
      .get(firstRequest.data.refund_request_id);
    assert.equal(legacyFundingLink.funding_lineage_id, null);

    const firstVerified = await verifyRefundFundingLineage(
      started.baseUrl,
      admin.token,
      firstRequest.data.refund_request_id,
      `${label}-first-verify`
    );
    const firstSweepState = testDb
      .prepare(`SELECT status, evidence_json FROM refund_funding_sweeps WHERE sweep_tx_hash = ?`)
      .get(sweepTx);
    assert.equal(firstVerified.status, 200, JSON.stringify({ response: firstVerified.data, sweep: firstSweepState }));
    assert.equal(firstVerified.data.funding_allocation_parts.length, 1);

    const secondVerified = await verifyRefundFundingLineage(
      started.baseUrl,
      admin.token,
      secondRequest.data.refund_request_id,
      `${label}-second-verify`
    );
    assert.equal(secondVerified.status, 409);
    assert.equal(secondVerified.data.error.code, "REFUND_FUNDING_UNDERALLOCATED");

    const secondRefundTx = randomTxHash(`refund-${label}`);
    const secondExecuted = await executeRefund(
      started.baseUrl,
      admin.token,
      secondRequest.data.refund_request_id,
      secondRefundTx,
      `${label}-second-execute`
    );
    assert.equal(secondExecuted.status, 200);
    rpc.registerTransfer({
      txHash: secondRefundTx,
      tokenContract,
      fromAddress: payerAddress,
      toAddress: payerAddress,
      amountBase: secondRequest.data.refund_amount_jpyc_base,
      blockNumber: 720,
    });
    rpc.setLatestBlock(722);
    const secondExecutionVerified = await verifyRefund(
      started.baseUrl,
      admin.token,
      secondRequest.data.refund_request_id,
      `${label}-second-execution-verify`
    );
    assert.equal(secondExecutionVerified.status, 409);
    assert.equal(secondExecutionVerified.data.error.code, "REFUND_FUNDING_LINEAGE_REQUIRED");

    const sweep = testDb
      .prepare(`SELECT id FROM refund_funding_sweeps WHERE sweep_tx_hash = ?`)
      .get(sweepTx);
    assert.ok(sweep?.id);
    const allocationTotals = testDb
      .prepare(
        `SELECT COUNT(*) AS allocation_count,
                COALESCE(SUM(amount_jpyc_base), 0) AS allocated_amount_jpyc_base,
                SUM(CASE WHEN refund_request_id = ? THEN 1 ELSE 0 END) AS second_refund_allocation_count
         FROM refund_funding_allocation_parts
         WHERE funding_sweep_id = ?`
      )
      .get(secondRequest.data.refund_request_id, sweep.id);
    assert.equal(allocationTotals.allocation_count, 1);
    assert.equal(
      BigInt(String(allocationTotals.allocated_amount_jpyc_base)),
      BigInt(firstRequest.data.refund_amount_jpyc_base)
    );
    assert.equal(allocationTotals.second_refund_allocation_count, 0);

    const auditResponse = await apiRequest(
      started.baseUrl,
      `/api/v1/audit-logs?target_type=refund&target_id=${encodeURIComponent(firstRequest.data.refund_request_id)}&limit=200`,
      { headers: authHeaders(admin.token) }
    );
    assert.equal(auditResponse.status, 200);
    const fundingAudit = auditResponse.data.audit_logs.find(
      (row) => row.action === "refund.funding_sweeps_verified"
    );
    assert.ok(fundingAudit);
    const afterState = JSON.parse(fundingAudit.after_state);
    assert.equal(afterState.conservation.refund_fully_funded, true);
    assert.equal(afterState.conservation.conserved, true);
    assert.equal(
      afterState.funding_sweeps[0].allocated_amount_jpyc_base,
      String(firstRequest.data.refund_amount_jpyc_base)
    );
    assert.equal(afterState.funding_sweeps[0].remaining_amount_jpyc_base, "0");
    assert.equal(afterState.funding_sweeps[0].allocations.length, 1);
  });

  await t.test("recorded refund is promoted to succeeded after exact on-chain verification", async () => {
    const scenario = await createRefundScenario("refund-success", 2200, 2400, 200, "0x4444444444444444444444444444444444444444");
    const refundTx = randomTxHash("refund-success");
    const execute = await executeRefund(started.baseUrl, admin.token, scenario.refundId, refundTx, "refund-success-execute");
    assert.equal(execute.status, 200);
    assert.equal(execute.data.status, "recorded");
    rpc.registerTransfer({
      txHash: refundTx,
      tokenContract,
      fromAddress: scenario.payerAddress,
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

  await t.test("semantic duplicate refund requests converge across idempotency keys", async () => {
    const scenario = await createRefundScenario("refund-semantic-duplicate", 2210, 2410, 200, "0x4747474747474747474747474747474747474747");
    const duplicate = await requestRefund(
      started.baseUrl,
      admin.token,
      scenario.invoice.review_case_id,
      200,
      scenario.refundToAddress,
      env.CHAIN_ID,
      "refund-semantic-duplicate-second"
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.refund_request_id, scenario.refundId);
    const audit = await apiRequest(
      started.baseUrl,
      `/api/v1/audit-logs?target_type=refund&target_id=${encodeURIComponent(scenario.refundId)}&limit=200`,
      { headers: authHeaders(admin.token) }
    );
    assert.equal(audit.status, 200);
    assert.equal(
      audit.data.audit_logs.filter((row) => row.action === "refund.request_deduplicated").length,
      1
    );
  });

  await t.test("parallel refund verification claims one key and converges across another actor and key", async () => {
    const scenario = await createRefundScenario("refund-parallel", 2250, 2450, 200, "0x4545454545454545454545454545454545454545");
    const refundTx = randomTxHash("refund-parallel");
    const execute = await executeRefund(started.baseUrl, admin.token, scenario.refundId, refundTx, "refund-parallel-execute");
    assert.equal(execute.status, 200);
    assert.equal(execute.data.status, "recorded");
    rpc.registerTransfer({
      txHash: refundTx,
      tokenContract,
      fromAddress: scenario.payerAddress,
      toAddress: scenario.refundToAddress,
      amountBase: scenario.refundAmountBase,
      blockNumber: 605,
    });
    rpc.setLatestBlock(607);

    const hold = holdNextReceiptResponse(rpc, refundTx);
    const idem = `refund-parallel-verify-${Date.now()}`;
    const firstRequest = verifyRefund(started.baseUrl, admin.token, scenario.refundId, idem);
    await waitForReceiptHold(hold);

    let competingRequest;
    try {
      const sameKey = await verifyRefund(started.baseUrl, admin.token, scenario.refundId, idem);
      assert.equal(sameKey.status, 409);
      assert.equal(sameKey.data.error.code, "IDEMPOTENCY_IN_PROGRESS");
      assert.equal(sameKey.headers.get("retry-after"), "1");

      const competingIdem = `refund-parallel-competing-${Date.now()}`;
      competingRequest = verifyRefund(
        started.baseUrl,
        approver.token,
        scenario.refundId,
        competingIdem
      );
      await waitForPendingIdempotencyClaim(testDb, competingIdem);
    } finally {
      hold.release();
    }

    const [first, competing] = await Promise.all([firstRequest, competingRequest]);
    const parallelDebug = JSON.stringify({ first, competing, logs: started.logs.slice(-12) });
    assert.equal(first.status, 200, parallelDebug);
    assert.equal(first.data.status, "succeeded");
    assert.equal(competing.status, 200);
    assert.equal(competing.data.status, "succeeded");
    assert.equal(first.data.refund_tx_hash, competing.data.refund_tx_hash);

    const replay = await verifyRefund(started.baseUrl, admin.token, scenario.refundId, idem);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, first.data);

    const audit = await apiRequest(
      started.baseUrl,
      `/api/v1/audit-logs?target_type=refund&target_id=${encodeURIComponent(scenario.refundId)}&limit=200`,
      { headers: authHeaders(admin.token) }
    );
    assert.equal(audit.status, 200);
    const verificationAudits = audit.data.audit_logs.filter((row) => row.action === "refund.verified_onchain");
    assert.equal(verificationAudits.length, 1, "refund verification transition must be audited exactly once");
  });

  await t.test("parallel refund verification rejects conflicting transaction evidence and audits once", async () => {
    const scenario = await createRefundScenario("refund-conflict", 2275, 2475, 200, "0x4646464646464646464646464646464646464646");
    const originalRefundTx = randomTxHash("refund-conflict-original");
    const competingRefundTx = randomTxHash("refund-conflict-competing");
    const execute = await executeRefund(started.baseUrl, admin.token, scenario.refundId, originalRefundTx, "refund-conflict-execute");
    assert.equal(execute.status, 200);
    assert.equal(execute.data.status, "recorded");
    for (const [txHash, blockNumber] of [[originalRefundTx, 608], [competingRefundTx, 609]]) {
      rpc.registerTransfer({
        txHash,
        tokenContract,
        fromAddress: scenario.payerAddress,
        toAddress: scenario.refundToAddress,
        amountBase: scenario.refundAmountBase,
        blockNumber,
      });
    }
    rpc.setLatestBlock(611);

    const hold = holdNextReceiptResponse(rpc, originalRefundTx);
    const originalIdem = `refund-conflict-original-${Date.now()}`;
    const originalRequest = verifyRefund(started.baseUrl, admin.token, scenario.refundId, originalIdem);
    await waitForReceiptHold(hold);

    let competingRequest;
    try {
      const competingIdem = `refund-conflict-competing-${Date.now()}`;
      competingRequest = verifyRefund(
        started.baseUrl,
        approver.token,
        scenario.refundId,
        competingIdem,
        competingRefundTx
      );
      await waitForPendingIdempotencyClaim(testDb, competingIdem);
    } finally {
      hold.release();
    }

    const [original, competing] = await Promise.all([originalRequest, competingRequest]);
    const accepted = [original, competing].find((response) => response.status === 200);
    const conflicted = [original, competing].find((response) => response.status === 409);
    assert.ok(accepted, JSON.stringify({ original, competing, logs: started.logs.slice(-12) }));
    assert.equal(accepted.data.status, "succeeded");
    assert.ok([originalRefundTx, competingRefundTx].includes(accepted.data.refund_tx_hash));
    assert.ok(conflicted, "one verification must fail closed");
    assert.equal(conflicted.data.error.code, "REFUND_VERIFICATION_CONFLICT");
    const conflictReplay = await verifyRefund(started.baseUrl, admin.token, scenario.refundId, originalIdem);
    assert.equal(conflictReplay.status, original.status);
    assert.deepEqual(conflictReplay.data, original.data);

    const audit = await apiRequest(
      started.baseUrl,
      `/api/v1/audit-logs?target_type=refund&target_id=${encodeURIComponent(scenario.refundId)}&limit=200`,
      { headers: authHeaders(admin.token) }
    );
    assert.equal(audit.status, 200);
    const verificationAudits = audit.data.audit_logs.filter((row) => row.action === "refund.verified_onchain");
    assert.equal(verificationAudits.length, 1, "only the accepted refund evidence may create a verification audit");
  });

  await t.test("mismatched refund transfer does not succeed", async () => {
    const wrongToken = await createRefundScenario("refund-wrong-token", 2300, 2500, 200, "0x5555555555555555555555555555555555555555");
    const wrongTokenTx = randomTxHash("refund-wrong-token");
    await executeRefund(started.baseUrl, admin.token, wrongToken.refundId, wrongTokenTx, "refund-wrong-token-execute");
    rpc.registerTransfer({
      txHash: wrongTokenTx,
      tokenContract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fromAddress: wrongToken.payerAddress,
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
      fromAddress: wrongTo.payerAddress,
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
      fromAddress: wrongAmount.payerAddress,
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
      fromAddress: pending.payerAddress,
      toAddress: pending.refundToAddress,
      amountBase: pending.refundAmountBase,
      blockNumber: 900,
    });
    rpc.setLatestBlock(900);
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

test("18-decimal token receipts preserve 6-decimal ledger amounts across manual ingest, refund, and sweep verification", async (t) => {
  const tokenContract = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
  const treasuryAddress = "0xdddddddddddddddddddddddddddddddddddddddd";
  const payerAddress = "0x4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f";
  const atomicPerLedgerBase = 10n ** 12n;
  const toTokenAtomic = (ledgerBase, dust = 0n) =>
    (BigInt(String(ledgerBase)) * atomicPerLedgerBase + dust).toString();
  const rpc = await startMockRpcServer({ chainId: 137, tokenDecimals: 18 });
  const env = baseServerEnv({
    ALLOW_MANUAL_PAYMENT_INGEST: "true",
    RPC_URLS: rpc.url,
    TOKEN_CONTRACT: tokenContract,
    APPROVED_JPYC_TOKEN_CONTRACT: tokenContract,
    TOKEN_DECIMALS: "18",
    JPYC_BASE_UNIT_SCALE: "1000000",
    REFUND_TREASURY_ADDRESS: treasuryAddress,
    REFUND_TREASURY_APPROVAL_REF: "TREASURY-2026-018",
  });
  const started = await startServerProcess(CWD, env);
  const testDb = new Database(env.DB_PATH, { readonly: true });

  t.after(async () => {
    testDb.close();
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
  await importReceiveAddresses(started.baseUrl, admin.token, 12, 700);

  await t.test("exact manual receipt stores raw atomic evidence and ledger amount", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1200, "manual-18-exact");
    const txHash = randomTxHash("manual-18-exact");
    const ledgerBase = detail.data.amounts.amount_jpyc_base;
    const amountAtomic = toTokenAtomic(ledgerBase);
    rpc.registerTransfer({
      txHash,
      tokenContract,
      fromAddress: payerAddress,
      toAddress: detail.data.chain.recipient_address,
      amountBase: amountAtomic,
      blockNumber: 1000,
    });
    rpc.setLatestBlock(1002);

    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-18-exact");
    assert.equal(ingest.status, 200);
    assert.equal(ingest.data.status, "paid");
    const event = testDb
      .prepare(`SELECT amount_jpyc_base, amount_atomic, raw_payload FROM payment_events WHERE invoice_id = ? AND tx_hash = ?`)
      .get(detail.data.invoice_id, txHash);
    assert.equal(event.amount_jpyc_base, ledgerBase);
    assert.equal(event.amount_atomic, amountAtomic);
    assert.equal(JSON.parse(event.raw_payload).amount_conversion_exact, true);
  });

  await t.test("non-exact manual receipt remains invoice-linked and enters integrity review", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 1300, "manual-18-dust");
    const txHash = randomTxHash("manual-18-dust");
    const ledgerBase = detail.data.amounts.amount_jpyc_base;
    const amountAtomic = toTokenAtomic(ledgerBase, 1n);
    rpc.registerTransfer({
      txHash,
      tokenContract,
      fromAddress: payerAddress,
      toAddress: detail.data.chain.recipient_address,
      amountBase: amountAtomic,
      blockNumber: 1010,
    });
    rpc.setLatestBlock(1012);

    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, txHash, "manual-18-dust");
    assert.equal(ingest.status, 200);
    assert.equal(ingest.data.status, "review_required");
    const event = testDb
      .prepare(`SELECT invoice_id, amount_jpyc_base, amount_atomic, recognition_status, raw_payload FROM payment_events WHERE tx_hash = ?`)
      .get(txHash);
    assert.equal(event.invoice_id, detail.data.invoice_id);
    assert.equal(event.amount_jpyc_base, ledgerBase);
    assert.equal(event.amount_atomic, amountAtomic);
    assert.equal(event.recognition_status, "review_required");
    assert.equal(JSON.parse(event.raw_payload).amount_conversion_exact, false);
    const heldInvoice = testDb
      .prepare(`SELECT status, integrity_hold, integrity_hold_reason FROM invoices WHERE id = ?`)
      .get(detail.data.invoice_id);
    assert.equal(heldInvoice.status, "review_required");
    assert.equal(Number(heldInvoice.integrity_hold), 1);
    assert.equal(heldInvoice.integrity_hold_reason, "non_exact_decimal_conversion");
  });

  await t.test("exact 18-decimal sweep and refund receipts verify ledger-denominated requests", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 2200, "refund-18");
    const paymentTx = randomTxHash("refund-18-payment");
    const paidLedgerBase = (BigInt(detail.data.amounts.amount_jpyc_base) + 200_000_000n).toString();
    rpc.registerTransfer({
      txHash: paymentTx,
      tokenContract,
      fromAddress: payerAddress,
      toAddress: detail.data.chain.recipient_address,
      amountBase: toTokenAtomic(paidLedgerBase),
      blockNumber: 1020,
    });
    rpc.setLatestBlock(1022);
    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, paymentTx, "refund-18-payment");
    assert.equal(ingest.status, 200);
    assert.equal(ingest.data.status, "review_required");

    const reviewed = await getInvoice(started.baseUrl, admin.token, detail.data.invoice_id);
    const requested = await requestRefund(
      started.baseUrl,
      admin.token,
      reviewed.data.review_case_id,
      200,
      payerAddress,
      env.CHAIN_ID,
      "refund-18-request"
    );
    assert.equal(requested.status, 201);
    const refundId = requested.data.refund_request_id;
    const refundLedgerBase = requested.data.refund_amount_jpyc_base;
    const approved = await approveRefund(started.baseUrl, approver.token, refundId, "refund-18-approve");
    assert.equal(approved.status, 200);

    const sweepTx = randomTxHash("refund-18-sweep");
    rpc.registerTransfer({
      txHash: sweepTx,
      tokenContract,
      fromAddress: detail.data.chain.recipient_address,
      toAddress: treasuryAddress,
      amountBase: toTokenAtomic(refundLedgerBase),
      blockNumber: 1030,
    });
    rpc.setLatestBlock(1032);
    const recorded = await recordRefundFundingLineage(
      started.baseUrl,
      admin.token,
      refundId,
      {
        source_address: detail.data.chain.recipient_address,
        treasury_address: treasuryAddress,
        chain_id: env.CHAIN_ID,
        sweep_tx_hash: sweepTx,
        sweep_amount_jpyc_base: refundLedgerBase,
      },
      "refund-18-sweep-record"
    );
    assert.equal(recorded.status, 201);
    const verifiedSweep = await verifyRefundFundingLineage(
      started.baseUrl,
      admin.token,
      refundId,
      "refund-18-sweep-verify"
    );
    assert.equal(verifiedSweep.status, 200);
    assert.equal(verifiedSweep.data.funding_lineage.status, "verified");

    const refundTx = randomTxHash("refund-18-transfer");
    const executed = await executeRefund(started.baseUrl, admin.token, refundId, refundTx, "refund-18-execute");
    assert.equal(executed.status, 200);
    rpc.registerTransfer({
      txHash: refundTx,
      tokenContract,
      fromAddress: treasuryAddress,
      toAddress: payerAddress,
      amountBase: toTokenAtomic(refundLedgerBase),
      blockNumber: 1040,
    });
    rpc.setLatestBlock(1042);
    const verifiedRefund = await verifyRefund(
      started.baseUrl,
      admin.token,
      refundId,
      `refund-18-verify-${Date.now()}`
    );
    assert.equal(verifiedRefund.status, 200);
    assert.equal(verifiedRefund.data.status, "succeeded");
  });

  await t.test("18-decimal sweep dust is rejected with durable raw-atomic evidence", async () => {
    const { detail } = await createInvoiceDetail(started.baseUrl, admin.token, 2300, "refund-18-dust-sweep");
    const paymentTx = randomTxHash("refund-18-dust-sweep-payment");
    const paidLedgerBase = (BigInt(detail.data.amounts.amount_jpyc_base) + 200_000_000n).toString();
    rpc.registerTransfer({
      txHash: paymentTx,
      tokenContract,
      fromAddress: payerAddress,
      toAddress: detail.data.chain.recipient_address,
      amountBase: toTokenAtomic(paidLedgerBase),
      blockNumber: 1050,
    });
    rpc.setLatestBlock(1052);
    const ingest = await manualIngest(started.baseUrl, admin.token, detail.data.invoice_id, paymentTx, "refund-18-dust-sweep-payment");
    assert.equal(ingest.status, 200);
    assert.equal(ingest.data.status, "review_required");

    const reviewed = await getInvoice(started.baseUrl, admin.token, detail.data.invoice_id);
    const requested = await requestRefund(
      started.baseUrl,
      admin.token,
      reviewed.data.review_case_id,
      200,
      payerAddress,
      env.CHAIN_ID,
      "refund-18-dust-sweep-request"
    );
    assert.equal(requested.status, 201);
    const refundId = requested.data.refund_request_id;
    const refundLedgerBase = requested.data.refund_amount_jpyc_base;
    const approved = await approveRefund(started.baseUrl, approver.token, refundId, "refund-18-dust-sweep-approve");
    assert.equal(approved.status, 200);

    const sweepTx = randomTxHash("refund-18-dust-sweep");
    rpc.registerTransfer({
      txHash: sweepTx,
      tokenContract,
      fromAddress: detail.data.chain.recipient_address,
      toAddress: treasuryAddress,
      amountBase: toTokenAtomic(refundLedgerBase, 1n),
      blockNumber: 1060,
    });
    rpc.setLatestBlock(1062);
    const recorded = await recordRefundFundingLineage(
      started.baseUrl,
      admin.token,
      refundId,
      {
        source_address: detail.data.chain.recipient_address,
        treasury_address: treasuryAddress,
        chain_id: env.CHAIN_ID,
        sweep_tx_hash: sweepTx,
        sweep_amount_jpyc_base: refundLedgerBase,
      },
      "refund-18-dust-sweep-record"
    );
    assert.equal(recorded.status, 201);
    const verified = await verifyRefundFundingLineage(
      started.baseUrl,
      admin.token,
      refundId,
      "refund-18-dust-sweep-verify"
    );
    assert.equal(verified.status, 409);
    assert.equal(verified.data.error.code, "REFUND_FUNDING_UNDERALLOCATED");

    const sweep = testDb
      .prepare(`SELECT status, evidence_json FROM refund_funding_sweeps WHERE sweep_tx_hash = ?`)
      .get(sweepTx);
    assert.equal(sweep.status, "verification_failed");
    const evidence = JSON.parse(sweep.evidence_json);
    assert.equal(evidence.failure_reason, "WRONG_AMOUNT");
    assert.equal(evidence.verification.transfer.amountBase, toTokenAtomic(refundLedgerBase, 1n));
    const allocations = testDb
      .prepare(`SELECT COUNT(*) AS count FROM refund_funding_allocation_parts WHERE funding_sweep_id = (SELECT id FROM refund_funding_sweeps WHERE sweep_tx_hash = ?)`)
      .get(sweepTx);
    assert.equal(Number(allocations.count), 0);
  });
});
