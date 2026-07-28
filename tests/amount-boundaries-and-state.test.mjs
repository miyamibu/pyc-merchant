import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { assessChainRuntimeRegistry, buildChainRuntimeRegistryRecord } from "../src/chain-runtime-registry.mjs";
import {
  buildReceiveAddressControlMessage,
  hashControlPayload,
  isReceiveAddressAllocatable,
  validateReceiveAddressControl,
} from "../src/address-control.mjs";
import {
  classifyRecoveryReport,
  normalizeRecoveryReportInput,
  RECOVERY_REPORT_STATUSES,
} from "../src/payment-recovery.mjs";
import { deriveInvoiceStateAxes } from "../src/state-axes.mjs";

const address = "0x1111111111111111111111111111111111111111";
const token = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
const tip = `0x${"a".repeat(64)}`;

test("chain runtime registry is ready only with a verified endpoint and tip hash", () => {
  const record = buildChainRuntimeRegistryRecord({
    chainId: "137",
    tokenContract: token,
    tokenDecimals: 18,
    endpoint: {
      endpoint_id: "sha256:endpoint-a",
      endpoint_state: "verified",
      observed: { chain_id: "137", token_contract: token, decimals: 18, latest_block: "100" },
    },
    latestBlockHash: tip,
  });
  assert.equal(record.status, "verified");
  assert.equal(assessChainRuntimeRegistry([record], { chainId: "137", tokenContract: token, tokenDecimals: 18 }).ok, true);
  assert.equal(assessChainRuntimeRegistry([], { chainId: "137", tokenContract: token, tokenDecimals: 18 }).ok, false);
  const lagging = buildChainRuntimeRegistryRecord({
    chainId: "137",
    tokenContract: token,
    tokenDecimals: 18,
    endpoint: {
      endpoint_id: "sha256:endpoint-b",
      endpoint_state: "verified",
      observed: { chain_id: "137", token_contract: token, decimals: 18, latest_block: "90" },
    },
    latestBlockHash: `0x${"b".repeat(64)}`,
  });
  const divergent = assessChainRuntimeRegistry([record, lagging], {
    chainId: "137",
    tokenContract: token,
    tokenDecimals: 18,
    maxTipLag: 3,
  });
  assert.equal(divergent.ok, false);
  assert.equal(divergent.status, "tip_divergence");
});

test("receive address control remains pending until cryptographic proof and sweep capability exist", async () => {
  const pending = validateReceiveAddressControl({ address, chain_id: "137", token_contract: token });
  assert.equal(pending.ok, false);
  assert.equal(pending.activation_status, "pending_proof");
  const unverifiedAttestation = validateReceiveAddressControl({
    address,
    chain_id: "137",
    token_contract: token,
    control_proof_type: "provider_attestation",
    control_proof_payload_hash: "a".repeat(64),
    control_verified_at: "2026-07-26T00:00:00.000Z",
    sweep_destination: "0x2222222222222222222222222222222222222222",
    sweep_capability: "verified",
    provider_reference: "attestation-1",
  });
  assert.equal(unverifiedAttestation.ok, false);
  assert.ok(unverifiedAttestation.errors.includes("CONTROL_PROOF_RUNTIME_VERIFICATION_REQUIRED"));

  const signer = Wallet.createRandom();
  const proofAddress = signer.address.toLowerCase();
  const sweepDestination = "0x2222222222222222222222222222222222222222";
  const message = buildReceiveAddressControlMessage({
    address: proofAddress,
    chainId: "137",
    tokenContract: token,
    sweepDestination,
  });
  const payloadHash = hashControlPayload({
    address: proofAddress,
    chain_id: "137",
    token_contract: token.toLowerCase(),
    sweep_destination: sweepDestination,
    message,
  });
  const signature = await signer.signMessage(message);
  const verified = validateReceiveAddressControl({
    address: proofAddress,
    chain_id: "137",
    token_contract: token,
    control_proof_type: "eoa_signature",
    control_proof_payload_hash: payloadHash,
    control_proof_message: message,
    control_proof_signature: signature,
    control_verified_at: "2026-07-26T00:00:00.000Z",
    sweep_destination: sweepDestination,
    sweep_capability: "verified",
  });
  assert.equal(verified.ok, true);
  assert.equal(isReceiveAddressAllocatable({ status: "available", ...verified.normalized }), true);
});

test("invoice state axes derive independently from the compatibility status", () => {
  assert.deepEqual(deriveInvoiceStateAxes({ status: "review_required", integrity_hold: 1 }), {
    payment_status: "detected",
    fulfillment_status: "hold",
    review_status: "open",
    integrity_status: "hold",
    accounting_status: "adjusted",
    refund_status: "none",
    monitoring_status: "integrity_hold",
  });
  assert.deepEqual(deriveInvoiceStateAxes({
    status: "paid",
    amount_jpyc_base: "1000000",
    paid_amount_jpyc_base: "1000000",
  }), {
    payment_status: "paid",
    fulfillment_status: "allowed",
    review_status: "none",
    integrity_status: "ok",
    accounting_status: "recognized",
    refund_status: "none",
    monitoring_status: "post_payment",
  });
  assert.deepEqual(deriveInvoiceStateAxes({
    status: "paid",
    payment_status: "confirming",
    fulfillment_status: "hold",
    review_status: "open",
    integrity_status: "hold",
    accounting_status: "adjusted",
    refund_status: "approved",
  }), {
    payment_status: "confirming",
    fulfillment_status: "hold",
    review_status: "open",
    integrity_status: "hold",
    accounting_status: "adjusted",
    refund_status: "approved",
    monitoring_status: "integrity_hold",
  });
});

test("recovery reports distinguish verified wrong chain/token from customer reports", () => {
  const normalized = normalizeRecoveryReportInput({
    chain_id: "1",
    tx_hash: `0x${"a".repeat(64)}`,
    reported_issue: "wrong_chain",
  });
  assert.equal(normalized.ok, true);
  assert.equal(classifyRecoveryReport({
    invoiceChainId: "137",
    requestedChainId: "1",
    officialTokenContract: token,
    expectedRecipient: "0x2222222222222222222222222222222222222222",
    rpcVerified: true,
    receiptFound: true,
    transferLogs: [{
      token_contract: token,
      to_address: "0x2222222222222222222222222222222222222222",
    }],
  }).status, RECOVERY_REPORT_STATUSES.VERIFIED_WRONG_CHAIN);
  assert.equal(classifyRecoveryReport({
    invoiceChainId: "137",
    requestedChainId: "137",
    officialTokenContract: token,
    expectedRecipient: "0x2222222222222222222222222222222222222222",
    rpcVerified: true,
    receiptFound: true,
    transferLogs: [{
      token_contract: "0x3333333333333333333333333333333333333333",
      to_address: "0x2222222222222222222222222222222222222222",
    }],
  }).status, RECOVERY_REPORT_STATUSES.VERIFIED_WRONG_TOKEN);
  assert.equal(classifyRecoveryReport({
    invoiceChainId: "137",
    requestedChainId: "1",
    officialTokenContract: token,
    expectedRecipient: "0x2222222222222222222222222222222222222222",
    reportedIssue: "wrong_chain",
    reporterType: "customer",
  }).status, RECOVERY_REPORT_STATUSES.CUSTOMER_REPORTED_WRONG_CHAIN);
});
