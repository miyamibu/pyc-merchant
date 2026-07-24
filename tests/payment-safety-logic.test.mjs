import test from "node:test";
import assert from "node:assert/strict";

import {
  decideMonitoringLifecycle,
  deriveFulfillmentHold,
  deriveReorgIntegrityHold,
  makePaymentLogic,
} from "../src/payment-logic.mjs";

const {
  qualifyTransfer,
  summarizeEligibleTransfers,
  decideQualifiedPaymentStatus,
} = makePaymentLogic({ jpycBaseUnitScale: 1, requiredConfirmations: 2 });

const baseInvoice = {
  id: "inv-1",
  status: "issued",
  chain_id: "137",
  token_contract: "0xjpyc",
  recipient_address: "0xrecipient",
  amount_jpyc_base: "1000",
  expires_at: "2026-07-25T12:00:00.000Z",
};

function transfer(overrides = {}) {
  return {
    id: "event-1",
    tx_hash: "0xtx1",
    log_index: 0,
    chain_id: "137",
    token_contract: "0xJPYC",
    to_address: "0xRecipient",
    amount_jpyc_base: "1000",
    confirmations: 2,
    canonical_status: "canonical",
    block_timestamp: "2026-07-25T11:59:00.000Z",
    observed_at: "2026-07-25T12:30:00.000Z",
    ...overrides,
  };
}

test("qualifyTransfer requires chain, token, recipient, canonicality, expiry, and confirmations", () => {
  const result = qualifyTransfer(baseInvoice, transfer());

  assert.equal(result.eligible, true);
  assert.equal(result.amountBase, "1000");
  assert.deepEqual(result.checks, {
    amountValid: true,
    amountConversionExact: true,
    chainMatches: true,
    tokenMatches: true,
    recipientMatches: true,
    canonical: true,
    expiryValid: true,
    blockTimestampValid: true,
    withinExpiry: true,
    confirmationsSatisfied: true,
  });
});

test("qualifyTransfer never treats a non-exact token conversion as eligible", () => {
  const result = qualifyTransfer(baseInvoice, transfer({
    amount_conversion_exact: false,
    amount_conversion_error: "non_exact_decimal_conversion",
  }));

  assert.equal(result.eligible, false);
  assert.equal(result.checks.amountConversionExact, false);
  assert.equal(result.reasonType, "CHAIN_INCONSISTENT");
  assert.equal(result.reasonLabel, "non_exact_decimal_conversion");
  assert.equal(summarizeEligibleTransfers(baseInvoice, [transfer({
    amount_conversion_exact: false,
    amount_conversion_error: "non_exact_decimal_conversion",
  })]).eligibleTotalAmountBase, "0");
});

test("qualifyTransfer fails closed when canonicality is absent", () => {
  const event = transfer();
  delete event.canonical_status;
  const result = qualifyTransfer(baseInvoice, event);

  assert.equal(result.eligible, false);
  assert.equal(result.canonicalStatus, "unknown");
  assert.equal(result.reasonLabel, "canonicality_unverified");
});

test("qualifyTransfer accepts an explicit canonical block hash match and rejects a mismatch", () => {
  const event = transfer({ canonical_status: undefined, block_hash: "0xAbC" });
  const matching = qualifyTransfer(baseInvoice, event, { canonicalBlockHash: "0xabc" });
  const mismatching = qualifyTransfer(baseInvoice, event, { canonicalBlockHash: "0xdef" });
  const missingEventHash = qualifyTransfer(
    baseInvoice,
    transfer({ canonical_status: undefined, block_hash: undefined }),
    { canonicalBlockHash: "0xabc" }
  );

  assert.equal(matching.eligible, true);
  assert.equal(mismatching.eligible, false);
  assert.equal(mismatching.reasonLabel, "non_canonical_transfer");
  assert.equal(missingEventHash.eligible, false);
  assert.equal(missingEventHash.reasonLabel, "canonicality_unverified");
});

test("qualifyTransfer reports mismatched transfer identity fields", () => {
  const wrongChain = qualifyTransfer(baseInvoice, transfer({ chain_id: "1" }));
  const wrongToken = qualifyTransfer(baseInvoice, transfer({ token_contract: "0xother" }));
  const wrongRecipient = qualifyTransfer(baseInvoice, transfer({ to_address: "0xother" }));

  assert.equal(wrongChain.reasonLabel, "wrong_chain");
  assert.equal(wrongToken.reasonLabel, "wrong_token");
  assert.equal(wrongRecipient.reasonLabel, "wrong_recipient");
  assert.equal(wrongChain.eligible, false);
  assert.equal(wrongToken.eligible, false);
  assert.equal(wrongRecipient.eligible, false);
});

test("qualifyTransfer uses each transfer block timestamp, never observed_at, for expiry", () => {
  const late = qualifyTransfer(baseInvoice, transfer({
    block_timestamp: "2026-07-25T12:00:01.000Z",
    observed_at: "2026-07-25T11:00:00.000Z",
  }));
  const boundary = qualifyTransfer(baseInvoice, transfer({
    block_timestamp: baseInvoice.expires_at,
    observed_at: "2026-07-26T00:00:00.000Z",
  }));

  assert.equal(late.eligible, false);
  assert.equal(late.reasonLabel, "late_arrival_after_expiry");
  assert.equal(boundary.eligible, true);
});

test("qualifyTransfer can recognize an in-expiry transfer after invoice expiry", () => {
  const result = qualifyTransfer({ ...baseInvoice, status: "expired" }, transfer());
  assert.equal(result.eligible, true);
});

test("qualifyTransfer rejects absent invoice expiry", () => {
  const result = qualifyTransfer({ ...baseInvoice, expires_at: null }, transfer());
  assert.equal(result.eligible, false);
  assert.equal(result.reasonLabel, "invalid_invoice_expiry");
});

test("summarizeEligibleTransfers excludes unconfirmed amounts from the eligible total", () => {
  const result = summarizeEligibleTransfers(baseInvoice, [
    transfer({ id: "event-300", tx_hash: "0x300", amount_jpyc_base: "300", confirmations: 1 }),
    transfer({ id: "event-700", tx_hash: "0x700", amount_jpyc_base: "700" }),
  ]);

  assert.equal(result.eligibleTotalAmountBase, "700");
  assert.equal(result.eligibleTransferCount, 1);
  assert.equal(result.pendingConfirmationCount, 1);
});

test("summarizeEligibleTransfers excludes late and noncanonical amounts", () => {
  const lateResult = summarizeEligibleTransfers(baseInvoice, [
    transfer({ id: "event-300", tx_hash: "0x300", amount_jpyc_base: "300" }),
    transfer({
      id: "event-700",
      tx_hash: "0x700",
      amount_jpyc_base: "700",
      block_timestamp: "2026-07-25T12:00:01.000Z",
    }),
  ]);
  const reorgResult = summarizeEligibleTransfers(baseInvoice, [
    transfer({
      id: "event-300",
      tx_hash: "0x300",
      amount_jpyc_base: "300",
      canonical_status: "reorged",
    }),
    transfer({ id: "event-700", tx_hash: "0x700", amount_jpyc_base: "700" }),
  ]);

  assert.equal(lateResult.eligibleTotalAmountBase, "300");
  assert.equal(reorgResult.eligibleTotalAmountBase, "700");
});

test("decideQualifiedPaymentStatus never auto-pays multiple transfers", () => {
  const decision = decideQualifiedPaymentStatus(baseInvoice, [
    transfer({ id: "event-300", tx_hash: "0x300", amount_jpyc_base: "300" }),
    transfer({ id: "event-700", tx_hash: "0x700", amount_jpyc_base: "700" }),
  ]);

  assert.equal(decision.eligibleTotalAmountBase, "1000");
  assert.equal(decision.nextStatus, "review_required");
  assert.equal(decision.reasonType, "SPLIT_PAYMENT");
  assert.equal(decision.reasonLabel, "multiple_transfers_require_review");
});

test("decideQualifiedPaymentStatus routes mixed eligibility transfers to split review", () => {
  const decision = decideQualifiedPaymentStatus(baseInvoice, [
    transfer({ id: "event-300", tx_hash: "0x300", amount_jpyc_base: "300", confirmations: 1 }),
    transfer({ id: "event-700", tx_hash: "0x700", amount_jpyc_base: "700" }),
  ]);

  assert.equal(decision.eligibleTotalAmountBase, "700");
  assert.equal(decision.nextStatus, "review_required");
  assert.equal(decision.reasonType, "SPLIT_PAYMENT");
});

test("decideQualifiedPaymentStatus pays only one exact eligible transfer", () => {
  const confirmed = decideQualifiedPaymentStatus(baseInvoice, [transfer()]);
  const pending = decideQualifiedPaymentStatus(baseInvoice, [transfer({ confirmations: 1 })]);
  const pendingShort = decideQualifiedPaymentStatus(baseInvoice, [
    transfer({ amount_jpyc_base: "900", confirmations: 1 }),
  ]);

  assert.equal(confirmed.nextStatus, "paid");
  assert.equal(pending.nextStatus, "confirming");
  assert.equal(pendingShort.nextStatus, "review_required");
  assert.equal(pendingShort.reasonType, "UNDERPAYMENT");
});

test("duplicate observations of the same persisted event are not treated as split payment", () => {
  const event = transfer();
  const decision = decideQualifiedPaymentStatus(baseInvoice, [event, { ...event }]);

  assert.equal(decision.transferCount, 1);
  assert.equal(decision.duplicateObservationCount, 1);
  assert.equal(decision.nextStatus, "paid");
});

test("an explicit integrity hold overrides an otherwise payable transfer", () => {
  const decision = decideQualifiedPaymentStatus(baseInvoice, [transfer()], { integrityHold: true });
  assert.equal(decision.nextStatus, "review_required");
  assert.equal(decision.reasonLabel, "payment_integrity_hold");
});

test("monitor lifecycle keeps active and post-payment invoices under continuous monitoring", () => {
  const issued = decideMonitoringLifecycle(baseInvoice, {
    latestBlock: 101,
    lastReconciledBlock: 100,
  });
  const paid = decideMonitoringLifecycle({ ...baseInvoice, status: "paid" }, {
    latestBlock: 101,
    lastReconciledBlock: 100,
  });
  const settled = decideMonitoringLifecycle({
    ...baseInvoice,
    status: "paid",
    settled_at: "2026-07-26T00:00:00.000Z",
  });

  assert.equal(issued.monitoringStatus, "active");
  assert.equal(paid.monitoringStatus, "post_payment");
  assert.equal(settled.monitoringStatus, "post_payment");
  assert.equal(paid.shouldMonitorContinuously, true);
  assert.equal(settled.shouldMonitorContinuously, true);
  assert.equal(paid.reconciliationDue, true);
});

test("expired hot window still leaves used/exposed address in global reconciliation", () => {
  const lifecycle = decideMonitoringLifecycle({ ...baseInvoice, status: "paid" }, {
    nowMs: Date.parse("2026-07-27T00:00:00.000Z"),
    monitorUntil: "2026-07-26T00:00:00.000Z",
    addressUsed: true,
    latestBlock: 200,
    lastReconciledBlock: 199,
  });

  assert.equal(lifecycle.hotWindowExpired, true);
  assert.equal(lifecycle.shouldMonitorContinuously, false);
  assert.equal(lifecycle.shouldReconcileUsedAddress, true);
  assert.equal(lifecycle.shouldMonitor, true);
  assert.equal(lifecycle.monitoringStatus, "reconciliation");
  assert.equal(lifecycle.reconciliationDue, true);
});

test("old or reissued invoice address remains monitored", () => {
  const lifecycle = decideMonitoringLifecycle({
    ...baseInvoice,
    status: "expired",
    replaced_by_invoice_id: "inv-2",
  });

  assert.equal(lifecycle.shouldMonitorContinuously, true);
  assert.equal(lifecycle.shouldReconcileUsedAddress, true);
});

test("draft address is inactive unless exposure is explicit", () => {
  const draft = decideMonitoringLifecycle({ ...baseInvoice, status: "draft" });
  const exposedDraft = decideMonitoringLifecycle(
    { ...baseInvoice, status: "draft" },
    { addressExposed: true }
  );

  assert.equal(draft.shouldMonitor, false);
  assert.equal(exposedDraft.shouldMonitor, true);
  assert.equal(exposedDraft.monitoringStatus, "reconciliation");
});

test("reorg detection immediately activates all integrity gates", () => {
  const decision = deriveReorgIntegrityHold({ reorgDetected: true });

  assert.equal(decision.integrityHold, true);
  assert.equal(decision.requiresReview, true);
  assert.equal(decision.paymentRecognitionAllowed, false);
  assert.equal(decision.fulfillmentAllowed, false);
  assert.equal(decision.settlementAllowed, false);
  assert.equal(decision.exportAllowed, false);
  assert.equal(decision.refundAllowed, false);
});

test("reorg integrity hold is sticky until explicit resolution and canonical reconfirmation", () => {
  const unresolved = deriveReorgIntegrityHold({ existingHold: true });
  const resolutionOnly = deriveReorgIntegrityHold({
    existingHold: true,
    resolutionRecorded: true,
  });
  const reconfirmed = deriveReorgIntegrityHold({
    existingHold: true,
    resolutionRecorded: true,
    canonicalReconfirmed: true,
  });
  const stillUnresolved = deriveReorgIntegrityHold({
    existingHold: true,
    resolutionRecorded: true,
    canonicalReconfirmed: true,
    unresolvedReorg: true,
  });

  assert.equal(unresolved.integrityHold, true);
  assert.equal(resolutionOnly.integrityHold, true);
  assert.equal(reconfirmed.integrityHold, false);
  assert.equal(reconfirmed.reasonLabel, "integrity_reconfirmed");
  assert.equal(stillUnresolved.integrityHold, true);
});

test("canonical mismatch independently activates integrity hold", () => {
  const decision = deriveReorgIntegrityHold({ canonicalStatus: "noncanonical" });
  assert.equal(decision.integrityHold, true);
  assert.equal(decision.reasonLabel, "canonical_block_mismatch");
});

test("fulfillment is allowed only for recognized payment without review or integrity hold", () => {
  const allowed = deriveFulfillmentHold({ invoiceStatus: "paid" });
  const reorgHeld = deriveFulfillmentHold({ invoiceStatus: "paid", integrityHold: true });
  const reviewHeld = deriveFulfillmentHold({
    invoiceStatus: "paid",
    transferDecision: { nextStatus: "review_required" },
  });
  const unconfirmed = deriveFulfillmentHold({ invoiceStatus: "confirming" });

  assert.equal(allowed.fulfillmentAllowed, true);
  assert.equal(reorgHeld.fulfillmentAllowed, false);
  assert.equal(reorgHeld.reasonLabel, "payment_integrity_hold");
  assert.equal(reviewHeld.fulfillmentAllowed, false);
  assert.equal(unconfirmed.fulfillmentAllowed, false);
});
