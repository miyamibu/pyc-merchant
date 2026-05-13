import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Wallet } from "ethers";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

function createSseToken(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(`sse.${body}`).digest("hex");
  return `${body}.${sig}`;
}

function receiveAddressProofScope({ env, address, sourceLabel, batchId, nonce }) {
  return {
    merchant_id: "merchant-001",
    store_id: "store-001",
    batch_id: batchId,
    source_label: sourceLabel,
    address: String(address).toLowerCase(),
    network: String(env.CHAIN_ID),
    token_contract: String(env.TOKEN_CONTRACT).toLowerCase(),
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: "2099-01-01T00:00:00.000Z",
    nonce,
  };
}

function receiveAddressProofMessage(scope) {
  return [
    "JPYC Merchant Ops receive address control",
    `merchant_id:${scope.merchant_id}`,
    `store_id:${scope.store_id}`,
    `batch_id:${scope.batch_id}`,
    `source_label:${scope.source_label}`,
    `address:${scope.address}`,
    `network:${scope.network}`,
    `token_contract:${scope.token_contract}`,
    `valid_from:${scope.valid_from}`,
    `valid_until:${scope.valid_until}`,
    `nonce:${scope.nonce}`,
  ].join("\n");
}

async function readFirstChunk(response) {
  const reader = response.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return Buffer.from(value || []).toString("utf8");
}

test("address pool allocation, reissue, audit, and SSE short-lived tokens", async () => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);

  try {
    const admin = await loginAs(started.baseUrl, {
      terminalCode: env.TERMINAL_CODE,
      pin: env.STAFF_PIN,
      staffName: "Demo Staff",
    });

    const importRes = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `pool-import-${Date.now()}`,
      }),
      body: JSON.stringify({
        source_label: "ops-seed",
        addresses: [
          { address: "0x1000000000000000000000000000000000000001", control_proof_type: "external_approval", approval_ref: "ADDR-TEST-1", audit_evidence_ref: "AUDIT-TEST-1" },
          { address: "0x1000000000000000000000000000000000000002", control_proof_type: "external_approval", approval_ref: "ADDR-TEST-2", audit_evidence_ref: "AUDIT-TEST-2" },
        ],
      }),
    });
    assert.equal(importRes.status, 201);
    assert.equal(importRes.data.imported_count, 2);
    assert.ok(importRes.data.receive_addresses.every((row) => row.status === "available"));

    const noProofImport = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `pool-import-pending-${Date.now()}`,
      }),
      body: JSON.stringify({
        source_label: "ops-seed",
        addresses: ["0x1000000000000000000000000000000000000099"],
      }),
    });
    assert.equal(noProofImport.status, 201);
    assert.equal(noProofImport.data.receive_addresses[0].status, "pending_verification");

    const invalidProofImport = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `pool-import-invalid-proof-${Date.now()}`,
      }),
      body: JSON.stringify({
        source_label: "ops-seed",
        addresses: [{
          address: "0x1000000000000000000000000000000000000098",
          control_proof_type: "external_approval",
          approval_ref: "ADDR-INVALID",
        }],
      }),
    });
    assert.equal(invalidProofImport.status, 400);
    assert.equal(invalidProofImport.data.error.code, "INVALID_CONTROL_PROOF");

	    const wallet = Wallet.createRandom();
	    const proofAddress = wallet.address.toLowerCase();
	    const proofScope = receiveAddressProofScope({
	      env,
	      address: proofAddress,
	      sourceLabel: "ops-seed",
	      batchId: "batch-address-pool-test",
	      nonce: `nonce-${Date.now()}`,
	    });
	    const signature = await wallet.signMessage(receiveAddressProofMessage(proofScope));
    const signatureProofImport = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `pool-import-sig-proof-${Date.now()}`,
      }),
      body: JSON.stringify({
        source_label: "ops-seed",
        addresses: [{
	          address: proofAddress,
	          control_proof_type: "eip191_signature",
	          signature,
	          proof_batch_id: proofScope.batch_id,
	          proof_nonce: proofScope.nonce,
	          proof_valid_from: proofScope.valid_from,
	          proof_valid_until: proofScope.valid_until,
	        }],
      }),
    });
	    assert.equal(signatureProofImport.status, 201);
	    assert.equal(signatureProofImport.data.receive_addresses[0].status, "available");
	    const disabledSignatureProof = await apiRequest(
	      started.baseUrl,
	      `/api/v1/admin/receive-addresses/${encodeURIComponent(signatureProofImport.data.receive_addresses[0].id)}/disable`,
	      {
	        method: "POST",
	        headers: authHeaders(admin.token, {
	          "content-type": "application/json",
	          "idempotency-key": `pool-disable-sig-proof-${Date.now()}`,
	        }),
	        body: JSON.stringify({ reason: "signature_proof_test_complete" }),
	      }
	    );
	    assert.equal(disabledSignatureProof.status, 200);

    const createTerminal = async (terminalCode) =>
      apiRequest(started.baseUrl, "/api/v1/terminals", {
        method: "POST",
        headers: authHeaders(admin.token, {
          "content-type": "application/json",
          "idempotency-key": `terminal-${terminalCode}-${Date.now()}`,
        }),
        body: JSON.stringify({
          terminal_code: terminalCode,
          status: "active",
        }),
      });

    const terminalTwo = await createTerminal("TERM-002");
    const terminalThree = await createTerminal("TERM-003");
    assert.equal(terminalTwo.status, 201);
    assert.equal(terminalThree.status, 201);

    const secondTerminalAdmin = await loginAs(started.baseUrl, {
      terminalCode: "TERM-002",
      pin: env.STAFF_PIN,
      staffName: "Demo Staff",
    });
    const thirdTerminalAdmin = await loginAs(started.baseUrl, {
      terminalCode: "TERM-003",
      pin: env.STAFF_PIN,
      staffName: "Demo Staff",
    });

    const first = await createInvoice(started.baseUrl, admin.token, 1000, `pool-inv-1-${Date.now()}`);
    const second = await createInvoice(started.baseUrl, secondTerminalAdmin.token, 1001, `pool-inv-2-${Date.now()}`);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const firstDetail = await getInvoice(started.baseUrl, admin.token, first.data.invoice_id);
    const secondDetail = await getInvoice(started.baseUrl, secondTerminalAdmin.token, second.data.invoice_id);
    assert.equal(firstDetail.status, 200);
    assert.equal(secondDetail.status, 200);
    assert.notEqual(firstDetail.data.chain.recipient_address, secondDetail.data.chain.recipient_address);

    const exhausted = await createInvoice(started.baseUrl, thirdTerminalAdmin.token, 1002, `pool-inv-3-${Date.now()}`);
    assert.equal(exhausted.status, 409);
    assert.equal(exhausted.data.error.code, "ADDRESS_POOL_EXHAUSTED");

    const importThird = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `pool-import-2-${Date.now()}`,
      }),
      body: JSON.stringify({
        source_label: "ops-seed",
        addresses: [{ address: "0x1000000000000000000000000000000000000003", control_proof_type: "external_approval", approval_ref: "ADDR-TEST-3", audit_evidence_ref: "AUDIT-TEST-3" }],
      }),
    });
    assert.equal(importThird.status, 201);

    const reissued = await apiRequest(started.baseUrl, `/api/v1/invoices/${encodeURIComponent(first.data.invoice_id)}/reissue`, {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `reissue-${Date.now()}`,
      }),
      body: "{}",
    });
    assert.equal(reissued.status, 201);
    assert.notEqual(reissued.data.receive_address, firstDetail.data.chain.recipient_address);

    const privateKeyImport = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `pool-import-invalid-${Date.now()}`,
      }),
      body: JSON.stringify({
        addresses: ["0x" + "a".repeat(64)],
      }),
    });
    assert.equal(privateKeyImport.status, 400);
    assert.equal(privateKeyImport.data.error.code, "PRIVATE_KEY_MATERIAL_REJECTED");

    const importFourth = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses:import", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `pool-import-3-${Date.now()}`,
      }),
      body: JSON.stringify({
        source_label: "ops-seed",
        addresses: [{ address: "0x1000000000000000000000000000000000000004", control_proof_type: "external_approval", approval_ref: "ADDR-TEST-4", audit_evidence_ref: "AUDIT-TEST-4" }],
      }),
    });
    assert.equal(importFourth.status, 201);

    const listed = await apiRequest(started.baseUrl, "/api/v1/admin/receive-addresses", {
      headers: authHeaders(admin.token),
    });
    assert.equal(listed.status, 200);
	    const availableRow = listed.data.receive_addresses.find((row) => row.address === "0x1000000000000000000000000000000000000004");
    assert.ok(availableRow);

    const disabled = await apiRequest(
      started.baseUrl,
      `/api/v1/admin/receive-addresses/${encodeURIComponent(availableRow.id)}/disable`,
      {
        method: "POST",
        headers: authHeaders(admin.token, {
          "content-type": "application/json",
          "idempotency-key": `pool-disable-${Date.now()}`,
        }),
        body: JSON.stringify({ reason: "ops_test" }),
      }
    );
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.receive_address.status, "disabled");

    const audit = await apiRequest(started.baseUrl, "/api/v1/audit-logs?limit=200", {
      headers: authHeaders(admin.token),
    });
    assert.equal(audit.status, 200);
    const actions = (audit.data.audit_logs || []).map((row) => row.action);
    assert.ok(actions.includes("receive_address.imported"));
    assert.ok(actions.includes("receive_address.allocated"));
    assert.ok(actions.includes("receive_address.disabled"));

    const sseTokenRes = await apiRequest(
      started.baseUrl,
      `/api/v1/invoices/${encodeURIComponent(reissued.data.invoice_id)}/sse-token`,
      {
        method: "POST",
        headers: authHeaders(admin.token, {
          "content-type": "application/json",
        }),
        body: "{}",
      }
    );
    assert.equal(sseTokenRes.status, 200);
    const validToken = sseTokenRes.data.token;

    const streamResponse = await fetch(
      `${started.baseUrl}/api/v1/streams/terminals/${encodeURIComponent(admin.terminalId)}?invoice_id=${encodeURIComponent(reissued.data.invoice_id)}&sse_token=${encodeURIComponent(validToken)}`
    );
    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get("content-type"), "text/event-stream");
    const firstChunk = await readFirstChunk(streamResponse);
    assert.match(firstChunk, /event: snapshot/);

    const wrongInvoice = await fetch(
      `${started.baseUrl}/api/v1/streams/terminals/${encodeURIComponent(admin.terminalId)}?invoice_id=${encodeURIComponent(first.data.invoice_id)}&sse_token=${encodeURIComponent(validToken)}`
    );
    assert.equal(wrongInvoice.status, 403);

    const sessionTokenOnly = await fetch(
      `${started.baseUrl}/api/v1/streams/terminals/${encodeURIComponent(admin.terminalId)}?invoice_id=${encodeURIComponent(reissued.data.invoice_id)}&sse_token=${encodeURIComponent(admin.token)}`
    );
    assert.equal(sessionTokenOnly.status, 403);

    const tampered = `${validToken.slice(0, -1)}${validToken.endsWith("0") ? "1" : "0"}`;
    const tamperedRes = await fetch(
      `${started.baseUrl}/api/v1/streams/terminals/${encodeURIComponent(admin.terminalId)}?invoice_id=${encodeURIComponent(reissued.data.invoice_id)}&sse_token=${encodeURIComponent(tampered)}`
    );
    assert.equal(tamperedRes.status, 403);

    const expiredToken = createSseToken(env.APP_SECRET, {
      aud: "sse",
      scope: "invoice:read",
      invoice_id: reissued.data.invoice_id,
      terminal_id: admin.terminalId,
      store_id: admin.storeId,
      session_id: admin.sessionId,
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const expiredRes = await fetch(
      `${started.baseUrl}/api/v1/streams/terminals/${encodeURIComponent(admin.terminalId)}?invoice_id=${encodeURIComponent(reissued.data.invoice_id)}&sse_token=${encodeURIComponent(expiredToken)}`
    );
    assert.equal(expiredRes.status, 401);

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!started.logs.join("").includes(validToken), "raw SSE token should be redacted from logs");
  } finally {
    await stopServerProcess(started.proc);
  }
});
