function reject(code, message, details = {}) {
  return {
    ok: false,
    decision: "reject",
    error: { code, message, details },
  };
}

function requiredId(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return { error: reject("REFUND_FUNDING_ALLOCATION_INVALID", `${label} is required`, { field: label }) };
  }
  return { value: normalized };
}

function positiveBaseUnits(value, label) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
    return {
      error: reject(
        "REFUND_FUNDING_ALLOCATION_INVALID",
        `${label} must be a positive safe integer or a base-unit integer string`,
        { field: label }
      ),
    };
  }
  const raw = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return {
      error: reject(
        "REFUND_FUNDING_ALLOCATION_INVALID",
        `${label} must be a positive base-unit integer`,
        { field: label }
      ),
    };
  }
  const parsed = BigInt(raw);
  if (parsed <= 0n) {
    return {
      error: reject(
        "REFUND_FUNDING_ALLOCATION_INVALID",
        `${label} must be a positive base-unit integer`,
        { field: label }
      ),
    };
  }
  return { value: parsed };
}

function normalizeAllocation(allocation, index) {
  const sweepId = requiredId(allocation?.sweep_id, `existing_allocations[${index}].sweep_id`);
  if (sweepId.error) return sweepId;
  const refundRequestId = requiredId(
    allocation?.refund_request_id,
    `existing_allocations[${index}].refund_request_id`
  );
  if (refundRequestId.error) return refundRequestId;
  const amount = positiveBaseUnits(
    allocation?.amount_jpyc_base,
    `existing_allocations[${index}].amount_jpyc_base`
  );
  if (amount.error) return amount;
  return {
    value: {
      ...allocation,
      sweep_id: sweepId.value,
      refund_request_id: refundRequestId.value,
      amount_jpyc_base: amount.value.toString(),
      idempotency_key: String(allocation?.idempotency_key || "").trim() || null,
      _amount: amount.value,
    },
  };
}

function normalizeInputs({ sweep, existingAllocations, request }) {
  const sweepId = requiredId(sweep?.id ?? sweep?.sweep_id, "sweep.id");
  if (sweepId.error) return sweepId.error;
  if (String(sweep?.status || "").trim() !== "verified") {
    return reject(
      "REFUND_FUNDING_SWEEP_NOT_VERIFIED",
      "refund funding allocations require a verified sweep",
      { sweep_id: sweepId.value, status: String(sweep?.status || "").trim() || null }
    );
  }
  const verifiedAmount = positiveBaseUnits(
    sweep?.verified_amount_jpyc_base ?? sweep?.sweep_amount_jpyc_base,
    "sweep.verified_amount_jpyc_base"
  );
  if (verifiedAmount.error) return verifiedAmount.error;

  const requestSweepId = requiredId(request?.sweep_id, "request.sweep_id");
  if (requestSweepId.error) return requestSweepId.error;
  if (requestSweepId.value !== sweepId.value) {
    return reject(
      "REFUND_FUNDING_ALLOCATION_INVALID",
      "request sweep_id does not match the verified sweep",
      { sweep_id: sweepId.value, request_sweep_id: requestSweepId.value }
    );
  }
  const refundRequestId = requiredId(request?.refund_request_id, "request.refund_request_id");
  if (refundRequestId.error) return refundRequestId.error;
  const allocationAmount = positiveBaseUnits(request?.amount_jpyc_base, "request.amount_jpyc_base");
  if (allocationAmount.error) return allocationAmount.error;
  const refundAmount = positiveBaseUnits(
    request?.refund_amount_jpyc_base,
    "request.refund_amount_jpyc_base"
  );
  if (refundAmount.error) return refundAmount.error;
  const idempotencyKey = requiredId(request?.idempotency_key, "request.idempotency_key");
  if (idempotencyKey.error) return idempotencyKey.error;

  if (!Array.isArray(existingAllocations)) {
    return reject(
      "REFUND_FUNDING_ALLOCATION_INVALID",
      "existingAllocations must be an array",
      { field: "existingAllocations" }
    );
  }

  const normalizedAllocations = [];
  for (const [index, allocation] of existingAllocations.entries()) {
    const normalized = normalizeAllocation(allocation, index);
    if (normalized.error) return normalized.error;
    normalizedAllocations.push(normalized.value);
  }

  return {
    ok: true,
    sweepId: sweepId.value,
    verifiedAmount: verifiedAmount.value,
    refundRequestId: refundRequestId.value,
    allocationAmount: allocationAmount.value,
    refundAmount: refundAmount.value,
    idempotencyKey: idempotencyKey.value,
    allocations: normalizedAllocations,
  };
}

function allocationTotals({ allocations, sweepId, refundRequestId }) {
  let sweepAllocated = 0n;
  let refundAllocated = 0n;
  for (const allocation of allocations) {
    if (allocation.sweep_id === sweepId) sweepAllocated += allocation._amount;
    if (allocation.refund_request_id === refundRequestId) refundAllocated += allocation._amount;
  }
  return { sweepAllocated, refundAllocated };
}

function successResult({
  decision,
  allocation,
  verifiedAmount,
  refundAmount,
  sweepAllocated,
  refundAllocated,
}) {
  const publicAllocation = allocation ? { ...allocation } : null;
  if (publicAllocation) {
    delete publicAllocation._amount;
    publicAllocation.amount_jpyc_base = String(publicAllocation.amount_jpyc_base);
  }
  return {
    ok: true,
    decision,
    allocation: publicAllocation,
    conservation: {
      verified_sweep_amount_jpyc_base: verifiedAmount.toString(),
      sweep_allocated_amount_jpyc_base: sweepAllocated.toString(),
      sweep_remaining_amount_jpyc_base: (verifiedAmount - sweepAllocated).toString(),
      refund_amount_jpyc_base: refundAmount.toString(),
      refund_allocated_amount_jpyc_base: refundAllocated.toString(),
      refund_remaining_amount_jpyc_base: (refundAmount - refundAllocated).toString(),
      refund_fully_funded: refundAllocated === refundAmount,
    },
  };
}

export function summarizeRefundFundingAllocations({
  sweep,
  existingAllocations = [],
  refundRequestId,
  refundAmountJpycBase,
} = {}) {
  const syntheticRequest = {
    sweep_id: sweep?.id ?? sweep?.sweep_id,
    refund_request_id: refundRequestId,
    amount_jpyc_base: "1",
    refund_amount_jpyc_base: refundAmountJpycBase,
    idempotency_key: "summary",
  };
  const normalized = normalizeInputs({ sweep, existingAllocations, request: syntheticRequest });
  if (!normalized.ok) return normalized;
  const totals = allocationTotals(normalized);
  if (totals.sweepAllocated > normalized.verifiedAmount) {
    return reject(
      "REFUND_FUNDING_SWEEP_OVERALLOCATED",
      "existing refund funding allocations exceed the verified sweep amount",
      {
        sweep_id: normalized.sweepId,
        verified_sweep_amount_jpyc_base: normalized.verifiedAmount.toString(),
        allocated_amount_jpyc_base: totals.sweepAllocated.toString(),
      }
    );
  }
  if (totals.refundAllocated > normalized.refundAmount) {
    return reject(
      "REFUND_FUNDING_REFUND_OVERALLOCATED",
      "existing refund funding allocations exceed the refund amount",
      {
        refund_request_id: normalized.refundRequestId,
        refund_amount_jpyc_base: normalized.refundAmount.toString(),
        allocated_amount_jpyc_base: totals.refundAllocated.toString(),
      }
    );
  }
  return successResult({
    decision: "summary",
    allocation: null,
    verifiedAmount: normalized.verifiedAmount,
    refundAmount: normalized.refundAmount,
    sweepAllocated: totals.sweepAllocated,
    refundAllocated: totals.refundAllocated,
  });
}

export function planRefundFundingAllocation({ sweep, existingAllocations = [], request } = {}) {
  const normalized = normalizeInputs({ sweep, existingAllocations, request });
  if (!normalized.ok) return normalized;

  const semanticMatches = normalized.allocations.filter(
    (allocation) => allocation.sweep_id === normalized.sweepId
      && allocation.refund_request_id === normalized.refundRequestId
  );
  if (semanticMatches.length > 1) {
    return reject(
      "REFUND_FUNDING_ALLOCATION_INTEGRITY_ERROR",
      "multiple allocations exist for the same sweep and refund",
      { sweep_id: normalized.sweepId, refund_request_id: normalized.refundRequestId }
    );
  }

  const keyMatches = normalized.allocations.filter(
    (allocation) => allocation.idempotency_key === normalized.idempotencyKey
  );
  if (keyMatches.length > 1) {
    return reject(
      "REFUND_FUNDING_ALLOCATION_INTEGRITY_ERROR",
      "an idempotency key is linked to multiple funding allocations",
      { idempotency_key: normalized.idempotencyKey }
    );
  }

  const totals = allocationTotals(normalized);
  if (totals.sweepAllocated > normalized.verifiedAmount) {
    return reject(
      "REFUND_FUNDING_SWEEP_OVERALLOCATED",
      "existing refund funding allocations exceed the verified sweep amount",
      {
        sweep_id: normalized.sweepId,
        verified_sweep_amount_jpyc_base: normalized.verifiedAmount.toString(),
        allocated_amount_jpyc_base: totals.sweepAllocated.toString(),
      }
    );
  }
  if (totals.refundAllocated > normalized.refundAmount) {
    return reject(
      "REFUND_FUNDING_REFUND_OVERALLOCATED",
      "existing refund funding allocations exceed the refund amount",
      {
        refund_request_id: normalized.refundRequestId,
        refund_amount_jpyc_base: normalized.refundAmount.toString(),
        allocated_amount_jpyc_base: totals.refundAllocated.toString(),
      }
    );
  }

  const matchesRequest = (allocation) => allocation.sweep_id === normalized.sweepId
    && allocation.refund_request_id === normalized.refundRequestId
    && allocation._amount === normalized.allocationAmount;
  if (keyMatches.length === 1 && !matchesRequest(keyMatches[0])) {
    return reject(
      "REFUND_FUNDING_ALLOCATION_IDEMPOTENCY_CONFLICT",
      "idempotency key was already used for a different funding allocation",
      { idempotency_key: normalized.idempotencyKey }
    );
  }
  if (semanticMatches.length === 1 && semanticMatches[0]._amount !== normalized.allocationAmount) {
    return reject(
      "REFUND_FUNDING_ALLOCATION_CONFLICT",
      "the sweep and refund are already linked with a different amount",
      {
        sweep_id: normalized.sweepId,
        refund_request_id: normalized.refundRequestId,
        existing_amount_jpyc_base: semanticMatches[0]._amount.toString(),
        requested_amount_jpyc_base: normalized.allocationAmount.toString(),
      }
    );
  }

  const replay = keyMatches[0] || semanticMatches[0] || null;
  if (replay) {
    return successResult({
      decision: "replay",
      allocation: {
        ...replay,
        idempotency_key: replay.idempotency_key || normalized.idempotencyKey,
      },
      verifiedAmount: normalized.verifiedAmount,
      refundAmount: normalized.refundAmount,
      sweepAllocated: totals.sweepAllocated,
      refundAllocated: totals.refundAllocated,
    });
  }

  const sweepAllocatedAfter = totals.sweepAllocated + normalized.allocationAmount;
  if (sweepAllocatedAfter > normalized.verifiedAmount) {
    return reject(
      "REFUND_FUNDING_SWEEP_OVERALLOCATED",
      "funding allocation would exceed the verified sweep amount",
      {
        sweep_id: normalized.sweepId,
        verified_sweep_amount_jpyc_base: normalized.verifiedAmount.toString(),
        allocated_before_jpyc_base: totals.sweepAllocated.toString(),
        requested_amount_jpyc_base: normalized.allocationAmount.toString(),
      }
    );
  }

  const refundAllocatedAfter = totals.refundAllocated + normalized.allocationAmount;
  if (refundAllocatedAfter > normalized.refundAmount) {
    return reject(
      "REFUND_FUNDING_REFUND_OVERALLOCATED",
      "funding allocation would exceed the refund amount",
      {
        refund_request_id: normalized.refundRequestId,
        refund_amount_jpyc_base: normalized.refundAmount.toString(),
        allocated_before_jpyc_base: totals.refundAllocated.toString(),
        requested_amount_jpyc_base: normalized.allocationAmount.toString(),
      }
    );
  }

  return successResult({
    decision: "create",
    allocation: {
      sweep_id: normalized.sweepId,
      refund_request_id: normalized.refundRequestId,
      amount_jpyc_base: normalized.allocationAmount.toString(),
      idempotency_key: normalized.idempotencyKey,
    },
    verifiedAmount: normalized.verifiedAmount,
    refundAmount: normalized.refundAmount,
    sweepAllocated: sweepAllocatedAfter,
    refundAllocated: refundAllocatedAfter,
  });
}
