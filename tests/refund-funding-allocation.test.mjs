import test from "node:test";
import assert from "node:assert/strict";
import {
  planRefundFundingAllocation,
  summarizeRefundFundingAllocations,
} from "../src/refund-funding-allocation.mjs";

const verifiedSweep = {
  id: "sweep-1",
  status: "verified",
  verified_amount_jpyc_base: "100",
};

function allocationRequest(overrides = {}) {
  return {
    sweep_id: "sweep-1",
    refund_request_id: "refund-1",
    amount_jpyc_base: "40",
    refund_amount_jpyc_base: "70",
    idempotency_key: "allocation-key-1",
    ...overrides,
  };
}

test("plans a funding allocation while conserving both sweep and refund amounts", () => {
  const result = planRefundFundingAllocation({
    sweep: verifiedSweep,
    existingAllocations: [
      {
        sweep_id: "sweep-1",
        refund_request_id: "refund-other",
        amount_jpyc_base: "10",
        idempotency_key: "other-refund",
      },
      {
        sweep_id: "sweep-other",
        refund_request_id: "refund-1",
        amount_jpyc_base: "20",
        idempotency_key: "other-sweep",
      },
    ],
    request: allocationRequest(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision, "create");
  assert.deepEqual(result.allocation, {
    sweep_id: "sweep-1",
    refund_request_id: "refund-1",
    amount_jpyc_base: "40",
    idempotency_key: "allocation-key-1",
  });
  assert.deepEqual(result.conservation, {
    verified_sweep_amount_jpyc_base: "100",
    sweep_allocated_amount_jpyc_base: "50",
    sweep_remaining_amount_jpyc_base: "50",
    refund_amount_jpyc_base: "70",
    refund_allocated_amount_jpyc_base: "60",
    refund_remaining_amount_jpyc_base: "10",
    refund_fully_funded: false,
  });
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("summarizes a refund funded by multiple verified sweeps", () => {
  const result = summarizeRefundFundingAllocations({
    sweep: {
      id: "sweep-2",
      status: "verified",
      verified_amount_jpyc_base: "100",
    },
    existingAllocations: [
      {
        sweep_id: "sweep-1",
        refund_request_id: "refund-1",
        amount_jpyc_base: "40",
      },
      {
        sweep_id: "sweep-2",
        refund_request_id: "refund-1",
        amount_jpyc_base: "30",
      },
    ],
    refundRequestId: "refund-1",
    refundAmountJpycBase: "70",
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision, "summary");
  assert.equal(result.allocation, null);
  assert.equal(result.conservation.sweep_allocated_amount_jpyc_base, "30");
  assert.equal(result.conservation.refund_allocated_amount_jpyc_base, "70");
  assert.equal(result.conservation.refund_remaining_amount_jpyc_base, "0");
  assert.equal(result.conservation.refund_fully_funded, true);
});

test("replays an exact idempotent allocation without adding its amount again", () => {
  const existingAllocation = {
    id: "allocation-1",
    sweep_id: "sweep-1",
    refund_request_id: "refund-1",
    amount_jpyc_base: "40",
    idempotency_key: "allocation-key-1",
  };
  const result = planRefundFundingAllocation({
    sweep: verifiedSweep,
    existingAllocations: [existingAllocation],
    request: allocationRequest(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision, "replay");
  assert.deepEqual(result.allocation, existingAllocation);
  assert.equal(result.conservation.sweep_allocated_amount_jpyc_base, "40");
  assert.equal(result.conservation.refund_allocated_amount_jpyc_base, "40");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("replays the same sweep/refund/amount tuple even under a new request key", () => {
  const result = planRefundFundingAllocation({
    sweep: verifiedSweep,
    existingAllocations: [{
      id: "allocation-1",
      sweep_id: "sweep-1",
      refund_request_id: "refund-1",
      amount_jpyc_base: "40",
      idempotency_key: "original-key",
    }],
    request: allocationRequest({ idempotency_key: "retry-key" }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision, "replay");
  assert.equal(result.allocation.idempotency_key, "original-key");
});

test("rejects idempotency and semantic conflicts", () => {
  const idempotencyConflict = planRefundFundingAllocation({
    sweep: verifiedSweep,
    existingAllocations: [{
      sweep_id: "sweep-1",
      refund_request_id: "refund-other",
      amount_jpyc_base: "40",
      idempotency_key: "allocation-key-1",
    }],
    request: allocationRequest(),
  });
  assert.equal(idempotencyConflict.ok, false);
  assert.equal(
    idempotencyConflict.error.code,
    "REFUND_FUNDING_ALLOCATION_IDEMPOTENCY_CONFLICT"
  );

  const semanticConflict = planRefundFundingAllocation({
    sweep: verifiedSweep,
    existingAllocations: [{
      sweep_id: "sweep-1",
      refund_request_id: "refund-1",
      amount_jpyc_base: "39",
      idempotency_key: "original-key",
    }],
    request: allocationRequest(),
  });
  assert.equal(semanticConflict.ok, false);
  assert.equal(semanticConflict.error.code, "REFUND_FUNDING_ALLOCATION_CONFLICT");
});

test("rejects allocations that would exceed either conservation boundary", () => {
  const sweepOverflow = planRefundFundingAllocation({
    sweep: verifiedSweep,
    existingAllocations: [{
      sweep_id: "sweep-1",
      refund_request_id: "refund-other",
      amount_jpyc_base: "70",
    }],
    request: allocationRequest(),
  });
  assert.equal(sweepOverflow.ok, false);
  assert.equal(sweepOverflow.error.code, "REFUND_FUNDING_SWEEP_OVERALLOCATED");

  const refundOverflow = planRefundFundingAllocation({
    sweep: verifiedSweep,
    existingAllocations: [{
      sweep_id: "sweep-other",
      refund_request_id: "refund-1",
      amount_jpyc_base: "40",
    }],
    request: allocationRequest(),
  });
  assert.equal(refundOverflow.ok, false);
  assert.equal(refundOverflow.error.code, "REFUND_FUNDING_REFUND_OVERALLOCATED");
});

test("fails closed for invalid or unverified funding inputs", () => {
  const unverified = planRefundFundingAllocation({
    sweep: { ...verifiedSweep, status: "detected" },
    request: allocationRequest(),
  });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.error.code, "REFUND_FUNDING_SWEEP_NOT_VERIFIED");

  for (const invalidAmount of ["0", "-1", "1.5", "", Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = planRefundFundingAllocation({
      sweep: verifiedSweep,
      request: allocationRequest({ amount_jpyc_base: invalidAmount }),
    });
    assert.equal(invalid.ok, false, `amount ${JSON.stringify(invalidAmount)} must fail`);
    assert.equal(invalid.error.code, "REFUND_FUNDING_ALLOCATION_INVALID");
  }

  const invalidExistingAllocations = planRefundFundingAllocation({
    sweep: verifiedSweep,
    existingAllocations: {},
    request: allocationRequest(),
  });
  assert.equal(invalidExistingAllocations.ok, false);
  assert.equal(
    invalidExistingAllocations.error.code,
    "REFUND_FUNDING_ALLOCATION_INVALID"
  );
});

test("detects already-corrupt allocation sets before planning a write", () => {
  const duplicatePair = planRefundFundingAllocation({
    sweep: verifiedSweep,
    existingAllocations: [
      { sweep_id: "sweep-1", refund_request_id: "refund-1", amount_jpyc_base: "10" },
      { sweep_id: "sweep-1", refund_request_id: "refund-1", amount_jpyc_base: "10" },
    ],
    request: allocationRequest({ amount_jpyc_base: "10" }),
  });
  assert.equal(duplicatePair.ok, false);
  assert.equal(duplicatePair.error.code, "REFUND_FUNDING_ALLOCATION_INTEGRITY_ERROR");

  const existingSweepOverflow = summarizeRefundFundingAllocations({
    sweep: verifiedSweep,
    existingAllocations: [
      { sweep_id: "sweep-1", refund_request_id: "refund-a", amount_jpyc_base: "60" },
      { sweep_id: "sweep-1", refund_request_id: "refund-b", amount_jpyc_base: "50" },
    ],
    refundRequestId: "refund-a",
    refundAmountJpycBase: "100",
  });
  assert.equal(existingSweepOverflow.ok, false);
  assert.equal(existingSweepOverflow.error.code, "REFUND_FUNDING_SWEEP_OVERALLOCATED");

  const existingRefundOverflow = summarizeRefundFundingAllocations({
    sweep: verifiedSweep,
    existingAllocations: [
      { sweep_id: "sweep-1", refund_request_id: "refund-a", amount_jpyc_base: "40" },
      { sweep_id: "sweep-other", refund_request_id: "refund-a", amount_jpyc_base: "40" },
    ],
    refundRequestId: "refund-a",
    refundAmountJpycBase: "70",
  });
  assert.equal(existingRefundOverflow.ok, false);
  assert.equal(existingRefundOverflow.error.code, "REFUND_FUNDING_REFUND_OVERALLOCATED");
});
