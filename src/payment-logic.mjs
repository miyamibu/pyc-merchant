/**
 * Pure payment decision logic — no DB, no env globals.
 * Instantiate with makePaymentLogic() so tests can control scale and confirmations.
 */
import { compareBaseUnits, parseDecimalToBaseUnits, scaleToDecimals } from "./amounts.mjs";
import { REVIEW_REASON_CODES } from "./reason-codes.mjs";

const ACTIVE_MONITORING_STATUSES = new Set([
  "issued",
  "payment_detected",
  "confirming",
  "expired",
  "review_required",
]);

function normalizeCanonicalState(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["canonical", "true", "valid"].includes(normalized)) return true;
  if (["noncanonical", "non_canonical", "orphaned", "reorged", "false", "invalid"].includes(normalized)) {
    return false;
  }
  return null;
}

function normalizeBlockNumber(value) {
  if (value == null || value === "") return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) return null;
  return normalized;
}

function transferIdentity(event, index) {
  const eventId = String(event?.id ?? "").trim();
  if (eventId) return `id:${eventId}`;
  const txHash = String(event?.tx_hash ?? event?.txHash ?? "").trim().toLowerCase();
  const logIndexRaw = event?.log_index ?? event?.logIndex;
  if (txHash && logIndexRaw != null && String(logIndexRaw).trim() !== "") {
    return `log:${txHash}:${String(logIndexRaw).trim()}`;
  }
  return `input:${index}`;
}

/**
 * Keep an exposed or used receive address observable after the invoice leaves
 * the checkout hot path. A finite monitor_until may end continuous polling,
 * but it must never remove the address from reconciliation.
 */
export function decideMonitoringLifecycle(invoice = {}, options = {}) {
  const status = String(invoice?.status ?? "").trim().toLowerCase();
  const recipientAddress = String(
    options.recipientAddress ?? invoice?.recipient_address ?? invoice?.recipientAddress ?? ""
  ).trim();
  const hasReceiveAddress = recipientAddress.length > 0;
  const addressExposed = options.addressExposed == null
    ? hasReceiveAddress && status !== "" && status !== "draft"
    : options.addressExposed === true;
  const addressUsed = options.addressUsed === true || options.paymentObserved === true;
  const paymentObserved = addressUsed
    || ["payment_detected", "confirming", "paid", "review_required"].includes(status)
    || Boolean(invoice?.paid_tx_hash ?? invoice?.paidTxHash);
  const postPayment = paymentObserved
    || status === "paid"
    || status === "settled"
    || Boolean(invoice?.settled_at ?? invoice?.settledAt);
  const integrityHold = options.integrityHold === true
    || invoice?.integrity_hold === true
    || invoice?.integrity_hold === 1
    || String(invoice?.integrity_status ?? "").toLowerCase() === "held";

  const nowMs = options.nowMs == null ? Date.now() : Number(options.nowMs);
  const monitorUntilRaw = options.monitorUntil ?? invoice?.monitor_until ?? invoice?.monitorUntil;
  const monitorUntilMs = monitorUntilRaw == null || monitorUntilRaw === ""
    ? null
    : new Date(monitorUntilRaw).getTime();
  const hasValidNow = Number.isFinite(nowMs);
  const hasValidMonitorUntil = monitorUntilMs == null || Number.isFinite(monitorUntilMs);
  const hotWindowExpired = monitorUntilMs != null
    && hasValidNow
    && hasValidMonitorUntil
    && nowMs > monitorUntilMs;

  const activeStatus = ACTIVE_MONITORING_STATUSES.has(status);
  const shouldMonitorContinuously = hasReceiveAddress
    && (integrityHold || activeStatus || (postPayment && !hotWindowExpired));
  const shouldReconcileUsedAddress = hasReceiveAddress
    && (addressExposed || addressUsed || postPayment || integrityHold);

  const latestBlock = normalizeBlockNumber(options.latestBlock);
  const lastReconciledBlock = normalizeBlockNumber(
    options.lastReconciledBlock ?? invoice?.last_reconciled_block ?? invoice?.lastReconciledBlock
  );
  const reconciliationDue = shouldReconcileUsedAddress && (
    latestBlock == null
    || lastReconciledBlock == null
    || lastReconciledBlock < latestBlock
  );

  let monitoringStatus = "inactive";
  let reasonLabel = hasReceiveAddress ? "monitoring_not_required" : "receive_address_unavailable";
  if (integrityHold && hasReceiveAddress) {
    monitoringStatus = "integrity_hold";
    reasonLabel = "integrity_hold_requires_monitoring";
  } else if (shouldMonitorContinuously && postPayment) {
    monitoringStatus = "post_payment";
    reasonLabel = "post_payment_monitoring";
  } else if (shouldMonitorContinuously) {
    monitoringStatus = "active";
    reasonLabel = "active_invoice_monitoring";
  } else if (shouldReconcileUsedAddress) {
    monitoringStatus = "reconciliation";
    reasonLabel = "used_address_reconciliation";
  }

  return {
    monitoringStatus,
    reasonLabel,
    shouldMonitor: shouldMonitorContinuously || shouldReconcileUsedAddress,
    shouldMonitorContinuously,
    shouldReconcileUsedAddress,
    reconciliationDue,
    hotWindowExpired,
    monitorUntil: Number.isFinite(monitorUntilMs) ? new Date(monitorUntilMs).toISOString() : null,
  };
}

/**
 * Reorg holds are sticky. They are released only after an explicit resolution
 * and canonical reconfirmation, with no currently unresolved reorg evidence.
 */
export function deriveReorgIntegrityHold(input = {}) {
  const existingHold = input.existingHold === true
    || input.integrityHold === true
    || String(input.integrityStatus ?? "").toLowerCase() === "held";
  const newReorgDetected = input.reorgDetected === true || input.newReorgDetected === true;
  const canonicalState = normalizeCanonicalState(input.canonicalStatus ?? input.canonical);
  const canonicalMismatch = input.canonicalMismatch === true || canonicalState === false;
  const unresolvedReorg = input.unresolvedReorg === true || Number(input.unresolvedReorgCount || 0) > 0;
  const activeEvidence = newReorgDetected || canonicalMismatch || unresolvedReorg;
  const resolutionRecorded = input.resolutionRecorded === true
    || String(input.resolutionStatus ?? "").toLowerCase() === "resolved";
  const canonicalReconfirmed = input.canonicalReconfirmed === true;
  const safeRelease = existingHold && !activeEvidence && resolutionRecorded && canonicalReconfirmed;
  const integrityHold = activeEvidence || (existingHold && !safeRelease);

  let reasonLabel = "payment_integrity_clear";
  if (newReorgDetected) reasonLabel = "chain_reorg_detected";
  else if (canonicalMismatch) reasonLabel = "canonical_block_mismatch";
  else if (unresolvedReorg) reasonLabel = "unresolved_chain_reorg";
  else if (integrityHold) reasonLabel = "integrity_resolution_pending";
  else if (safeRelease) reasonLabel = "integrity_reconfirmed";

  return {
    integrityHold,
    integrityStatus: integrityHold ? "held" : "clear",
    reasonLabel,
    requiresReview: integrityHold,
    paymentRecognitionAllowed: !integrityHold,
    fulfillmentAllowed: !integrityHold,
    settlementAllowed: !integrityHold,
    exportAllowed: !integrityHold,
    refundAllowed: !integrityHold,
  };
}

export function deriveFulfillmentHold(input = {}) {
  const invoiceStatus = String(input.invoiceStatus ?? input.invoice?.status ?? "").trim().toLowerCase();
  const integrityHold = input.integrityHold === true
    || input.integrityDecision?.integrityHold === true
    || String(input.integrityStatus ?? "").toLowerCase() === "held";
  const transferStatus = String(input.transferDecision?.nextStatus ?? "").trim().toLowerCase();
  const reviewRequired = input.reviewRequired === true
    || invoiceStatus === "review_required"
    || transferStatus === "review_required";
  const paymentRecognized = input.paymentRecognized == null
    ? (transferStatus ? transferStatus === "paid" : ["paid", "settled"].includes(invoiceStatus))
    : input.paymentRecognized === true;
  const fulfillmentHold = integrityHold || reviewRequired || !paymentRecognized;

  let reasonLabel = "payment_confirmed_for_fulfillment";
  if (integrityHold) reasonLabel = "payment_integrity_hold";
  else if (reviewRequired) reasonLabel = "payment_review_required";
  else if (!paymentRecognized) reasonLabel = "payment_not_confirmed";

  return {
    fulfillmentHold,
    fulfillmentAllowed: !fulfillmentHold,
    reasonLabel,
    requiresReview: integrityHold || reviewRequired,
  };
}

export function makePaymentLogic({ jpycBaseUnitScale, requiredConfirmations = 2 } = {}) {
  let appDecimals;
  try {
    appDecimals = scaleToDecimals(String(jpycBaseUnitScale));
  } catch (_error) {
    throw new Error("jpycBaseUnitScale must be an explicit power-of-10 positive integer");
  }
  if (!Number.isFinite(requiredConfirmations) || requiredConfirmations < 0 || !Number.isInteger(requiredConfirmations)) {
    throw new Error("requiredConfirmations must be a non-negative integer");
  }

  function normalizeBaseAmount(value, decimalFallback) {
    if (value != null && value !== "") {
      const raw = String(value).trim();
      if (!/^[0-9]+$/.test(raw)) return { error: "invalid_amount_base" };
      return { value: raw };
    }
    try {
      return { value: parseDecimalToBaseUnits(String(decimalFallback ?? ""), appDecimals) };
    } catch (_error) {
      return { error: "invalid_amount" };
    }
  }

  function toBaseUnits(amountJpyc) {
    return normalizeBaseAmount(null, amountJpyc);
  }

  function qualifyTransfer(invoice, event, options = {}) {
    const amountBaseResult = normalizeBaseAmount(event?.amount_jpyc_base, event?.amount_jpyc);
    const eventChainId = String(event?.chain_id ?? "").trim();
    const invoiceChainId = String(invoice?.chain_id ?? "").trim();
    const eventTokenContract = String(event?.token_contract ?? "").trim().toLowerCase();
    const invoiceTokenContract = String(invoice?.token_contract ?? "").trim().toLowerCase();
    const eventRecipient = String(event?.to_address ?? "").trim().toLowerCase();
    const invoiceRecipient = String(invoice?.recipient_address ?? "").trim().toLowerCase();
    const invoiceExpiryRaw = invoice?.expires_at;
    const invoiceExpiryMs = invoiceExpiryRaw == null || invoiceExpiryRaw === ""
      ? Number.NaN
      : new Date(invoiceExpiryRaw).getTime();
    const blockTimestampRaw = options.blockTimestamp ?? event?.block_timestamp ?? event?.blockTimestamp;
    const blockTimestampMs = blockTimestampRaw == null || blockTimestampRaw === ""
      ? Number.NaN
      : new Date(blockTimestampRaw).getTime();

    let canonicalState = normalizeCanonicalState(
      options.canonicalStatus
      ?? options.canonical
      ?? event?.canonical_status
      ?? event?.canonical
      ?? event?.is_canonical
    );
    const canonicalBlockHash = String(options.canonicalBlockHash ?? "").trim().toLowerCase();
    const eventBlockHash = String(event?.block_hash ?? event?.blockHash ?? "").trim().toLowerCase();
    if (canonicalBlockHash) {
      canonicalState = eventBlockHash
        ? canonicalBlockHash === eventBlockHash && canonicalState !== false
        : null;
    }

    const confirmations = Number(event?.confirmations ?? 0);
    const amountConversionExact = event?.amount_conversion_exact !== false
      && String(event?.amount_conversion_error ?? "").trim() !== "non_exact_decimal_conversion";
    const checks = {
      amountValid: !amountBaseResult.error,
      amountConversionExact,
      chainMatches: eventChainId.length > 0 && invoiceChainId.length > 0 && eventChainId === invoiceChainId,
      tokenMatches: eventTokenContract.length > 0
        && invoiceTokenContract.length > 0
        && eventTokenContract === invoiceTokenContract,
      recipientMatches: eventRecipient.length > 0
        && invoiceRecipient.length > 0
        && eventRecipient === invoiceRecipient,
      canonical: canonicalState === true,
      expiryValid: Number.isFinite(invoiceExpiryMs),
      blockTimestampValid: Number.isFinite(blockTimestampMs),
      withinExpiry: Number.isFinite(invoiceExpiryMs)
        && Number.isFinite(blockTimestampMs)
        && blockTimestampMs <= invoiceExpiryMs,
      confirmationsSatisfied: Number.isFinite(confirmations)
        && Number.isInteger(confirmations)
        && confirmations >= requiredConfirmations,
    };

    const failures = [];
    if (!checks.amountValid) {
      failures.push({ reasonType: REVIEW_REASON_CODES.OTHER, reasonLabel: "invalid_event_amount" });
    }
    if (!checks.amountConversionExact) {
      failures.push({ reasonType: REVIEW_REASON_CODES.CHAIN_INCONSISTENT, reasonLabel: "non_exact_decimal_conversion" });
    }
    if (!checks.chainMatches) {
      failures.push({ reasonType: REVIEW_REASON_CODES.CHAIN_INCONSISTENT, reasonLabel: "wrong_chain" });
    }
    if (!checks.tokenMatches) {
      failures.push({ reasonType: REVIEW_REASON_CODES.UNKNOWN_TRANSFER, reasonLabel: "wrong_token" });
    }
    if (!checks.recipientMatches) {
      failures.push({ reasonType: REVIEW_REASON_CODES.ADDRESS_MISMATCH, reasonLabel: "wrong_recipient" });
    }
    if (canonicalState === false) {
      failures.push({ reasonType: REVIEW_REASON_CODES.CHAIN_INCONSISTENT, reasonLabel: "non_canonical_transfer" });
    } else if (canonicalState == null) {
      failures.push({ reasonType: REVIEW_REASON_CODES.CHAIN_INCONSISTENT, reasonLabel: "canonicality_unverified" });
    }
    if (!checks.expiryValid) {
      failures.push({ reasonType: REVIEW_REASON_CODES.OTHER, reasonLabel: "invalid_invoice_expiry" });
    } else if (!checks.blockTimestampValid) {
      failures.push({ reasonType: REVIEW_REASON_CODES.OTHER, reasonLabel: "invalid_block_timestamp" });
    } else if (!checks.withinExpiry) {
      failures.push({ reasonType: REVIEW_REASON_CODES.LATE_PAYMENT, reasonLabel: "late_arrival_after_expiry" });
    }
    if (!checks.confirmationsSatisfied) {
      failures.push({ reasonType: null, reasonLabel: "awaiting_confirmations" });
    }

    const eligible = Object.values(checks).every(Boolean);
    const primaryFailure = failures[0] || null;
    return {
      eligible,
      amountBase: amountBaseResult.error ? null : amountBaseResult.value,
      confirmations: Number.isFinite(confirmations) ? confirmations : null,
      blockTimestamp: Number.isFinite(blockTimestampMs) ? new Date(blockTimestampMs).toISOString() : null,
      canonicalStatus: canonicalState === true ? "canonical" : (canonicalState === false ? "noncanonical" : "unknown"),
      checks,
      failures,
      reasonType: primaryFailure?.reasonType ?? null,
      reasonLabel: primaryFailure?.reasonLabel ?? "eligible_transfer",
    };
  }

  function summarizeEligibleTransfers(invoice, events = [], options = {}) {
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    const uniqueEvents = new Map();
    events.forEach((event, index) => {
      uniqueEvents.set(transferIdentity(event, index), event);
    });
    const qualificationOptions = typeof options.qualificationOptions === "function"
      ? options.qualificationOptions
      : () => options.qualificationOptions || {};
    const qualifications = [...uniqueEvents.entries()].map(([identity, event], index) => ({
      identity,
      event,
      qualification: qualifyTransfer(invoice, event, qualificationOptions(event, index) || {}),
    }));
    const eligibleTotalAmountBase = qualifications.reduce((total, item) => {
      if (!item.qualification.eligible) return total;
      return total + BigInt(item.qualification.amountBase);
    }, 0n).toString();
    const eligibleTransferCount = qualifications.filter((item) => item.qualification.eligible).length;
    const pendingConfirmationCount = qualifications.filter((item) => {
      const checks = item.qualification.checks;
      return checks.amountValid
        && checks.amountConversionExact
        && checks.chainMatches
        && checks.tokenMatches
        && checks.recipientMatches
        && checks.canonical
        && checks.expiryValid
        && checks.blockTimestampValid
        && checks.withinExpiry
        && !checks.confirmationsSatisfied;
    }).length;

    return {
      transferCount: qualifications.length,
      eligibleTransferCount,
      ineligibleTransferCount: qualifications.length - eligibleTransferCount,
      pendingConfirmationCount,
      multipleTransfers: qualifications.length > 1,
      duplicateObservationCount: events.length - qualifications.length,
      eligibleTotalAmountBase,
      qualifications,
    };
  }

  function decideQualifiedPaymentStatus(invoice, events = [], options = {}) {
    const invoiceBaseResult = normalizeBaseAmount(invoice?.amount_jpyc_base, invoice?.amount_jpyc);
    const summary = summarizeEligibleTransfers(invoice, events, options);
    if (invoiceBaseResult.error) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.OTHER,
        reasonLabel: "invalid_invoice_amount",
      };
    }
    if (options.integrityHold === true) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.CHAIN_INCONSISTENT,
        reasonLabel: "payment_integrity_hold",
      };
    }
    if (String(invoice?.status || "").trim().toLowerCase() === "expired") {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.LATE_PAYMENT,
        reasonLabel: "late_arrival_after_expiry",
      };
    }
    if (summary.multipleTransfers) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.SPLIT_PAYMENT,
        reasonLabel: "multiple_transfers_require_review",
      };
    }
    if (summary.transferCount === 0) {
      return {
        ...summary,
        nextStatus: String(invoice?.status || "issued"),
        reasonType: null,
        reasonLabel: "no_transfer",
      };
    }

    const onlyTransfer = summary.qualifications[0].qualification;
    if (!onlyTransfer.eligible) {
      const onlyAwaitingConfirmations = onlyTransfer.failures.length === 1
        && onlyTransfer.failures[0].reasonLabel === "awaiting_confirmations";
      if (onlyAwaitingConfirmations) {
        const pendingAmountComparison = compareBaseUnits(onlyTransfer.amountBase, invoiceBaseResult.value);
        if (pendingAmountComparison < 0) {
          return {
            ...summary,
            nextStatus: "review_required",
            reasonType: REVIEW_REASON_CODES.UNDERPAYMENT,
            reasonLabel: "insufficient_amount",
          };
        }
        if (pendingAmountComparison > 0) {
          return {
            ...summary,
            nextStatus: "review_required",
            reasonType: REVIEW_REASON_CODES.OVERPAYMENT,
            reasonLabel: "overpay_detected",
          };
        }
      }
      return {
        ...summary,
        nextStatus: onlyAwaitingConfirmations ? "confirming" : "review_required",
        reasonType: onlyAwaitingConfirmations ? null : onlyTransfer.reasonType,
        reasonLabel: onlyAwaitingConfirmations ? "awaiting_confirmations" : onlyTransfer.reasonLabel,
      };
    }

    const comparison = compareBaseUnits(summary.eligibleTotalAmountBase, invoiceBaseResult.value);
    if (comparison < 0) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.UNDERPAYMENT,
        reasonLabel: "insufficient_amount",
      };
    }
    if (comparison > 0) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.OVERPAYMENT,
        reasonLabel: "overpay_detected",
      };
    }
    return {
      ...summary,
      nextStatus: "paid",
      reasonType: null,
      reasonLabel: "confirmed_single_transfer",
    };
  }

  function decidePaymentStatus(invoice, event, options = {}) {
    const amountBaseResult = normalizeBaseAmount(event.amount_jpyc_base, event.amount_jpyc);
    if (amountBaseResult.error) {
      return { nextStatus: "review_required", reasonType: REVIEW_REASON_CODES.OTHER, reasonLabel: "invalid_event_amount" };
    }
    const invoiceBaseResult = normalizeBaseAmount(invoice.amount_jpyc_base, invoice.amount_jpyc);
    if (invoiceBaseResult.error) {
      return { nextStatus: "review_required", reasonType: REVIEW_REASON_CODES.OTHER, reasonLabel: "invalid_invoice_amount" };
    }
    const amountBase = amountBaseResult.value;
    const invoiceBase = invoiceBaseResult.value;
    const previousPaidBaseResult = normalizeBaseAmount(
      options.previousPaidAmountBase != null ? options.previousPaidAmountBase : invoice.paid_amount_jpyc_base,
      invoice.paid_amount_jpyc
    );
    const previousPaidBase = previousPaidBaseResult.error ? "0" : previousPaidBaseResult.value;
    const totalPaidBaseResult = normalizeBaseAmount(
      options.totalPaidAmountBase,
      null
    );
    const totalPaidBase = totalPaidBaseResult.error || options.totalPaidAmountBase == null
      ? (BigInt(previousPaidBase) + BigInt(amountBase)).toString()
      : totalPaidBaseResult.value;
    const confirmations = Number(event.confirmations || 0);
    const observedAtMs = options.blockTimestamp != null
      ? new Date(options.blockTimestamp).getTime()
      : (event?.block_timestamp
        ? new Date(event.block_timestamp).getTime()
        : (options.nowMs != null
          ? Number(options.nowMs)
          : (event?.observed_at ? new Date(event.observed_at).getTime() : Date.now())));
    const expiryMs = new Date(invoice.expires_at).getTime();

    if (!Number.isFinite(expiryMs)) {
      return { nextStatus: "review_required", reasonType: REVIEW_REASON_CODES.OTHER, reasonLabel: "invalid_invoice_expiry" };
    }
    if (!Number.isFinite(observedAtMs)) {
      return { nextStatus: "review_required", reasonType: REVIEW_REASON_CODES.OTHER, reasonLabel: "invalid_observed_at" };
    }
    if (observedAtMs > expiryMs) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.LATE_PAYMENT,
        reasonLabel: "late_arrival_after_expiry",
      };
    }

    if (invoice.status === "expired") {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.LATE_PAYMENT,
        reasonLabel: "late_arrival_after_expiry",
      };
    }
    if (String(event.chain_id) !== String(invoice.chain_id)) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.CHAIN_INCONSISTENT,
        reasonLabel: "wrong_chain",
      };
    }
    if (String(event.token_contract).toLowerCase() !== String(invoice.token_contract).toLowerCase()) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.UNKNOWN_TRANSFER,
        reasonLabel: "wrong_token",
      };
    }
    if (String(event.to_address).toLowerCase() !== String(invoice.recipient_address).toLowerCase()) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.ADDRESS_MISMATCH,
        reasonLabel: "wrong_recipient",
      };
    }
    if (invoice.status === "paid" && options.eventAlreadyRecorded !== true) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.DUPLICATE_PAYMENT,
        reasonLabel: "duplicate_after_paid",
      };
    }
    if (compareBaseUnits(totalPaidBase, invoiceBase) < 0) {
      if (compareBaseUnits(previousPaidBase, "0") > 0) {
        return {
          nextStatus: "review_required",
          reasonType: REVIEW_REASON_CODES.SPLIT_PAYMENT,
          reasonLabel: "split_payment_incomplete",
        };
      }
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.UNDERPAYMENT,
        reasonLabel: "insufficient_amount",
      };
    }
    if (compareBaseUnits(totalPaidBase, invoiceBase) > 0) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.OVERPAYMENT,
        reasonLabel: "overpay_detected",
      };
    }
    if (confirmations >= requiredConfirmations) {
      return { nextStatus: "paid", reasonType: null, reasonLabel: "confirmed" };
    }
    return { nextStatus: "confirming", reasonType: null, reasonLabel: "awaiting_confirmations" };
  }

  return {
    toBaseUnits,
    decidePaymentStatus,
    qualifyTransfer,
    summarizeEligibleTransfers,
    decideQualifiedPaymentStatus,
  };
}
