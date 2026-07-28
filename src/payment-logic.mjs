/**
 * Pure payment decision logic — no DB, no env globals.
 * Instantiate with makePaymentLogic() so tests can control scale and confirmations.
 */
import {
  compareBaseUnits,
  parseDecimalToBaseUnits,
  parseUnsignedIntegerString,
  scaleToDecimals,
  tokenAtomicToLedgerBase,
} from "./amounts.mjs";
import { REVIEW_REASON_CODES } from "./reason-codes.mjs";

const ACTIVE_MONITORING_STATUSES = new Set([
  "issued",
  "payment_detected",
  "confirming",
  "expired",
  "review_required",
]);

const PAYMENT_CONTRACT_REASON_CODES = Object.freeze({
  CHAIN_TRANSFER_IDENTITY_INCOMPLETE: "CHAIN_TRANSFER_IDENTITY_INCOMPLETE",
  TIMESTAMP_UNVERIFIED: "TIMESTAMP_UNVERIFIED",
});

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

export function normalizeChainId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^[0-9]+$/.test(raw)) return BigInt(raw).toString();
  return raw.toLowerCase();
}

function normalizeTxHash(value) {
  const raw = String(value ?? "").trim();
  return raw ? raw.toLowerCase() : null;
}

function normalizeLogIndex(value) {
  const raw = String(value ?? "").trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  return BigInt(raw).toString();
}

function transferIdentityParts(event = {}) {
  const chainId = normalizeChainId(event?.chain_id ?? event?.chainId);
  const txHash = normalizeTxHash(event?.tx_hash ?? event?.txHash);
  const logIndex = normalizeLogIndex(event?.log_index ?? event?.logIndex);
  const missingFields = [
    chainId == null ? "chain_id" : null,
    txHash == null ? "tx_hash" : null,
    logIndex == null ? "log_index" : null,
  ].filter(Boolean);
  return {
    complete: missingFields.length === 0,
    missingFields,
    chainId,
    txHash,
    logIndex,
    identity: missingFields.length === 0 ? `${chainId}:${txHash}:${logIndex}` : null,
  };
}

function transferIdentity(event) {
  return transferIdentityParts(event).identity;
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

export function makePaymentLogic({
  jpycBaseUnitScale,
  ledgerBaseUnitScale,
  ledgerDecimals: ledgerDecimalsInput,
  tokenDecimals = 18,
  requiredConfirmations = 2,
  enableAutoSplitPayment = false,
} = {}) {
  let appDecimals;
  if (ledgerDecimalsInput != null && ledgerDecimalsInput !== "") {
    appDecimals = Number(ledgerDecimalsInput);
    if (!Number.isInteger(appDecimals) || appDecimals < 0 || appDecimals > 36) {
      throw new Error("ledgerDecimals must be an integer between 0 and 36");
    }
  } else {
    try {
      appDecimals = scaleToDecimals(String(jpycBaseUnitScale ?? ledgerBaseUnitScale));
    } catch (_error) {
      throw new Error("jpycBaseUnitScale must be an explicit power-of-10 positive integer");
    }
  }
  if (!Number.isInteger(Number(tokenDecimals)) || Number(tokenDecimals) < 0 || Number(tokenDecimals) > 36) {
    throw new Error("tokenDecimals must be an integer between 0 and 36");
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

  function normalizeAtomicBackedAmount({ atomicValue, ledgerValue, decimalFallback, label }) {
    let atomic;
    try {
      atomic = parseUnsignedIntegerString(atomicValue, label).toString();
    } catch (_error) {
      return { error: "invalid_token_amount_atomic", exact: false, atomic: null };
    }

    const converted = tokenAtomicToLedgerBase(atomic, Number(tokenDecimals), appDecimals);
    if (!converted.exact) {
      return {
        value: converted.value,
        atomic,
        exact: false,
        error: "non_exact_decimal_conversion",
      };
    }

    const explicitLedger = ledgerValue != null && String(ledgerValue).trim() !== ""
      ? normalizeBaseAmount(ledgerValue, null)
      : null;
    if (explicitLedger?.error) {
      return { error: "invalid_ledger_amount_base", exact: false, atomic };
    }
    if (explicitLedger && explicitLedger.value !== converted.value) {
      return {
        value: converted.value,
        atomic,
        exact: false,
        error: "ledger_amount_mismatch",
      };
    }

    if (!explicitLedger && decimalFallback != null && String(decimalFallback).trim() !== "") {
      const parsedDecimal = normalizeBaseAmount(null, decimalFallback);
      if (parsedDecimal.error) {
        return { error: "invalid_amount", exact: false, atomic };
      }
      if (parsedDecimal.value !== converted.value) {
        return {
          value: converted.value,
          atomic,
          exact: false,
          error: "ledger_amount_mismatch",
        };
      }
    }

    return { value: converted.value, atomic, exact: true, error: null };
  }

  function normalizeTransferAmount(event = {}) {
    const atomicValue = event?.token_amount_atomic ?? event?.amount_atomic;
    if (atomicValue != null && String(atomicValue).trim() !== "") {
      const result = normalizeAtomicBackedAmount({
        atomicValue,
        ledgerValue: event?.ledger_amount_base ?? event?.amount_jpyc_base,
        decimalFallback: event?.amount_jpyc,
        label: "token_amount_atomic",
      });
      const declaredConversionError = String(event?.amount_conversion_error ?? "").trim();
      const exact = result.exact !== false
        && event?.amount_conversion_exact !== false
        && !declaredConversionError;
      return {
        ...result,
        exact,
        error: result.error || (exact ? null : declaredConversionError || "non_exact_decimal_conversion"),
      };
    }
    const result = normalizeBaseAmount(
      event?.ledger_amount_base ?? event?.amount_jpyc_base,
      event?.amount_jpyc
    );
    const declaredConversionError = String(event?.amount_conversion_error ?? "").trim();
    const exact = event?.amount_conversion_exact !== false && !declaredConversionError;
    return {
      ...result,
      atomic: null,
      exact,
      error: result.error || (exact ? null : declaredConversionError || "non_exact_decimal_conversion"),
    };
  }

  function normalizeInvoiceAmount(invoice = {}) {
    const atomicValue = invoice?.token_amount_atomic ?? invoice?.amount_atomic;
    if (atomicValue != null && String(atomicValue).trim() !== "") {
      return normalizeAtomicBackedAmount({
        atomicValue,
        ledgerValue: invoice?.ledger_amount_base ?? invoice?.amount_jpyc_base,
        decimalFallback: invoice?.amount_jpyc,
        label: "token_amount_atomic",
      });
    }
    return normalizeBaseAmount(
      invoice?.ledger_amount_base ?? invoice?.amount_jpyc_base,
      invoice?.amount_jpyc
    );
  }

  function qualifyTransfer(invoice, event, options = {}) {
    const amountBaseResult = normalizeTransferAmount(event);
    const identityInfo = transferIdentityParts(event);
    const eventChainId = normalizeChainId(event?.chain_id ?? event?.chainId);
    const invoiceChainId = normalizeChainId(invoice?.chain_id ?? invoice?.chainId);
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
    const amountConversionExact = amountBaseResult.exact !== false
      && !String(event?.amount_conversion_error ?? "").trim();
    const checks = {
      amountValid: !amountBaseResult.error,
      amountConversionExact,
      chainMatches: eventChainId != null && invoiceChainId != null && eventChainId === invoiceChainId,
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
    if (!identityInfo.complete) {
      failures.push({
        reasonType: PAYMENT_CONTRACT_REASON_CODES.CHAIN_TRANSFER_IDENTITY_INCOMPLETE,
        reasonLabel: PAYMENT_CONTRACT_REASON_CODES.CHAIN_TRANSFER_IDENTITY_INCOMPLETE,
      });
    }
    if (!checks.amountValid) {
      failures.push({
        reasonType: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
        reasonLabel: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
      });
    } else if (!checks.amountConversionExact) {
      failures.push({
        reasonType: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
        reasonLabel: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
      });
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
      failures.push({
        reasonType: PAYMENT_CONTRACT_REASON_CODES.TIMESTAMP_UNVERIFIED,
        reasonLabel: PAYMENT_CONTRACT_REASON_CODES.TIMESTAMP_UNVERIFIED,
      });
    } else if (!checks.withinExpiry) {
      failures.push({ reasonType: REVIEW_REASON_CODES.LATE_PAYMENT, reasonLabel: "late_arrival_after_expiry" });
    }
    if (!checks.confirmationsSatisfied) {
      failures.push({ reasonType: null, reasonLabel: "awaiting_confirmations" });
    }

    const eligible = identityInfo.complete && Object.values(checks).every(Boolean);
    const candidate = identityInfo.complete
      && checks.amountValid
      && checks.amountConversionExact
      && checks.chainMatches
      && checks.tokenMatches
      && checks.recipientMatches
      && checks.canonical
      && checks.expiryValid
      && checks.blockTimestampValid
      && checks.withinExpiry;
    const primaryFailure = failures[0] || null;
    return {
      eligible,
      candidate,
      identity: identityInfo.identity,
      identityComplete: identityInfo.complete,
      identityMissingFields: identityInfo.missingFields,
      amountError: amountBaseResult.error || null,
      amountBase: amountBaseResult.error ? null : (amountBaseResult.value ?? null),
      amountAtomic: amountBaseResult.atomic,
      confirmations: Number.isFinite(confirmations) ? confirmations : null,
      blockTimestamp: Number.isFinite(blockTimestampMs) ? new Date(blockTimestampMs).toISOString() : null,
      canonicalStatus: canonicalState === true ? "canonical" : (canonicalState === false ? "noncanonical" : "unknown"),
      checks,
      failures,
      reasonType: primaryFailure?.reasonType ?? null,
      reasonLabel: primaryFailure?.reasonLabel ?? "eligible_transfer",
    };
  }

  function qualificationScore(item) {
    const checks = item.qualification.checks;
    return (checks.chainMatches ? 1_000_000 : 0)
      + (checks.tokenMatches ? 100_000 : 0)
      + (checks.recipientMatches ? 10_000 : 0)
      + (checks.amountValid ? 1_000 : 0)
      + (checks.amountConversionExact ? 500 : 0)
      + (checks.canonical ? 100 : 0)
      + (checks.blockTimestampValid ? 10 : 0)
      + (checks.withinExpiry ? 5 : 0)
      + (checks.confirmationsSatisfied ? 1 : 0);
  }

  function summarizeEligibleTransfers(invoice, events = [], options = {}) {
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    const qualificationOptions = typeof options.qualificationOptions === "function"
      ? options.qualificationOptions
      : () => options.qualificationOptions || {};
    const observations = events.map((event, index) => {
      const identityInfo = transferIdentityParts(event);
      return {
        event,
        index,
        identity: identityInfo.identity,
        identityInfo,
        qualification: qualifyTransfer(invoice, event, qualificationOptions(event, index) || {}),
      };
    });
    const groups = new Map();
    for (const observation of observations) {
      if (!observation.identityInfo.complete) continue;
      const group = groups.get(observation.identity) || {
        identity: observation.identity,
        firstIndex: observation.index,
        observations: [],
      };
      group.observations.push(observation);
      groups.set(observation.identity, group);
    }

    const distinctEntries = [...groups.values()].map((group) => {
      const representative = group.observations.reduce((best, current) => (
        qualificationScore(current) > qualificationScore(best) ? current : best
      ));
      return {
        firstIndex: group.firstIndex,
        identity: group.identity,
        event: representative.event,
        observationCount: group.observations.length,
        amountIntegrityErrorCount: group.observations.filter((item) => item.qualification.amountError).length,
        timestampUnverifiedCount: group.observations.filter(
          (item) => !item.qualification.checks.blockTimestampValid
        ).length,
        qualification: representative.qualification,
      };
    });
    const incompleteEntries = observations
      .filter((observation) => !observation.identityInfo.complete)
      .map((observation) => ({
        firstIndex: observation.index,
        identity: null,
        event: observation.event,
        observationCount: 1,
        amountIntegrityErrorCount: observation.qualification.amountError ? 1 : 0,
        timestampUnverifiedCount: observation.qualification.checks.blockTimestampValid ? 0 : 1,
        qualification: observation.qualification,
      }));
    const qualifications = [...distinctEntries, ...incompleteEntries]
      .sort((left, right) => left.firstIndex - right.firstIndex)
      .map(({ firstIndex: _firstIndex, ...entry }) => entry);
    const eligibleTotalAmountBase = qualifications.reduce((total, item) => {
      if (!item.qualification.eligible) return total;
      return total + BigInt(item.qualification.amountBase);
    }, 0n).toString();
    const eligibleTransferCount = qualifications.filter((item) => item.qualification.eligible).length;
    const candidateTransferCount = qualifications.filter((item) => item.qualification.candidate).length;
    const distinctTransferCount = groups.size;
    const identityIncompleteObservationCount = incompleteEntries.length;
    const pendingConfirmationCount = qualifications.filter((item) => (
      item.qualification.candidate && !item.qualification.eligible
    )).length;

    return {
      transferCount: distinctTransferCount,
      distinctTransferCount,
      observationCount: events.length,
      eligibleTransferCount,
      candidateTransferCount,
      ineligibleTransferCount: qualifications.length - eligibleTransferCount,
      nonCandidateTransferCount: qualifications.length - candidateTransferCount,
      pendingConfirmationCount,
      multipleTransfers: candidateTransferCount > 1,
      duplicateObservationCount: events.length - identityIncompleteObservationCount - distinctTransferCount,
      identityIncompleteObservationCount,
      amountIntegrityErrorCount: qualifications.reduce(
        (total, item) => total + item.amountIntegrityErrorCount,
        0
      ),
      timestampUnverifiedCount: qualifications.reduce(
        (total, item) => total + item.timestampUnverifiedCount,
        0
      ),
      eligibleTotalAmountBase,
      qualifications,
    };
  }

  function resolvePrimaryTransferIdentity(invoice = {}, options = {}) {
    const explicitIdentity = options.primaryTransferIdentity
      ?? invoice.primary_transfer_identity
      ?? invoice.primaryTransferIdentity;
    if (explicitIdentity != null && String(explicitIdentity).trim() !== "") {
      return String(explicitIdentity).trim().toLowerCase();
    }
    const primaryTransfer = options.primaryTransfer ?? invoice.primary_transfer;
    if (primaryTransfer && typeof primaryTransfer === "object") {
      return transferIdentity(primaryTransfer);
    }
    return transferIdentity({
      chain_id: options.primaryChainId ?? invoice.paid_chain_id ?? invoice.paidChainId ?? invoice.chain_id,
      tx_hash: options.primaryTxHash ?? invoice.paid_tx_hash ?? invoice.paidTxHash,
      log_index: options.primaryLogIndex ?? invoice.paid_log_index ?? invoice.paidLogIndex,
    });
  }

  function isFinalInvoice(invoice = {}) {
    const status = String(invoice?.status ?? "").trim().toLowerCase();
    return ["paid", "settled"].includes(status)
      || Boolean(invoice?.paid_tx_hash ?? invoice?.paidTxHash);
  }

  function decideQualifiedPaymentStatus(invoice, events = [], options = {}) {
    const invoiceBaseResult = normalizeInvoiceAmount(invoice);
    const summary = summarizeEligibleTransfers(invoice, events, options);
    if (invoiceBaseResult.error) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
        reasonLabel: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
      };
    }
    if (summary.identityIncompleteObservationCount > 0) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: PAYMENT_CONTRACT_REASON_CODES.CHAIN_TRANSFER_IDENTITY_INCOMPLETE,
        reasonLabel: PAYMENT_CONTRACT_REASON_CODES.CHAIN_TRANSFER_IDENTITY_INCOMPLETE,
      };
    }
    if (summary.amountIntegrityErrorCount > 0) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
        reasonLabel: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
      };
    }
    if (summary.timestampUnverifiedCount > 0) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: PAYMENT_CONTRACT_REASON_CODES.TIMESTAMP_UNVERIFIED,
        reasonLabel: PAYMENT_CONTRACT_REASON_CODES.TIMESTAMP_UNVERIFIED,
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
      const hasLateBlockTimestamp = summary.qualifications.some((item) => (
        item.qualification.checks.expiryValid
        && item.qualification.checks.blockTimestampValid
        && !item.qualification.checks.withinExpiry
      ));
      if (hasLateBlockTimestamp) {
        return {
          ...summary,
          nextStatus: "review_required",
          reasonType: REVIEW_REASON_CODES.LATE_PAYMENT,
          reasonLabel: "late_arrival_after_expiry",
        };
      }
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.OTHER,
        reasonLabel: "detected_after_expiry",
      };
    }

    const candidateItems = summary.qualifications.filter((item) => item.qualification.candidate);
    const primaryTransferIdentity = resolvePrimaryTransferIdentity(invoice, options);
    const finalInvoice = isFinalInvoice(invoice);
    const newCandidateItems = primaryTransferIdentity
      ? candidateItems.filter((item) => item.identity !== primaryTransferIdentity)
      : candidateItems;
    if (finalInvoice && (
      newCandidateItems.length > 0
      && (primaryTransferIdentity != null || candidateItems.length > 1)
    )) {
      return {
        ...summary,
        primaryTransferIdentity,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.DUPLICATE_PAYMENT,
        reasonLabel: "duplicate_after_primary_transfer",
      };
    }
    if (!finalInvoice && candidateItems.length > 1) {
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.SPLIT_PAYMENT,
        reasonLabel: "multiple_transfers_require_review",
      };
    }
    if (summary.transferCount === 0 && summary.qualifications.length === 0) {
      return {
        ...summary,
        nextStatus: String(invoice?.status || "issued"),
        reasonType: null,
        reasonLabel: "no_transfer",
      };
    }
    if (candidateItems.length === 0) {
      const firstQualification = summary.qualifications[0]?.qualification;
      return {
        ...summary,
        nextStatus: "review_required",
        reasonType: firstQualification?.reasonType ?? REVIEW_REASON_CODES.OTHER,
        reasonLabel: firstQualification?.reasonLabel ?? "no_eligible_transfer",
      };
    }

    const onlyTransfer = candidateItems[0].qualification;
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
      primaryTransferIdentity,
      nextStatus: "paid",
      reasonType: null,
      reasonLabel: "confirmed_single_transfer",
    };
  }

  function decidePaymentStatus(invoice = {}, event = {}, options = {}) {
    const amountBaseResult = normalizeTransferAmount(event);
    const invoiceBaseResult = normalizeInvoiceAmount(invoice);
    const previousPaidAmountProvided = options.previousPaidAmountBase != null
      || (invoice.paid_amount_jpyc_base != null && String(invoice.paid_amount_jpyc_base).trim() !== "")
      || (invoice.paid_amount_jpyc != null && String(invoice.paid_amount_jpyc).trim() !== "");
    const previousPaidBaseResult = previousPaidAmountProvided
      ? normalizeBaseAmount(
        options.previousPaidAmountBase != null ? options.previousPaidAmountBase : invoice.paid_amount_jpyc_base,
        invoice.paid_amount_jpyc
      )
      : { value: "0" };
    const totalPaidBaseResult = options.totalPaidAmountBase == null
      ? { value: null }
      : normalizeBaseAmount(options.totalPaidAmountBase, null);
    if (amountBaseResult.error || invoiceBaseResult.error || previousPaidBaseResult.error || totalPaidBaseResult.error) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
        reasonLabel: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
      };
    }

    const identityInfo = transferIdentityParts(event);
    if (!identityInfo.complete) {
      return {
        nextStatus: "review_required",
        reasonType: PAYMENT_CONTRACT_REASON_CODES.CHAIN_TRANSFER_IDENTITY_INCOMPLETE,
        reasonLabel: PAYMENT_CONTRACT_REASON_CODES.CHAIN_TRANSFER_IDENTITY_INCOMPLETE,
      };
    }
    const amountBase = amountBaseResult.value;
    const invoiceBase = invoiceBaseResult.value;
    const blockTimestampRaw = options.blockTimestamp ?? event?.block_timestamp ?? event?.blockTimestamp;
    const blockTimestampMs = blockTimestampRaw == null || blockTimestampRaw === ""
      ? Number.NaN
      : new Date(blockTimestampRaw).getTime();
    const expiryMs = invoice?.expires_at == null || invoice.expires_at === ""
      ? Number.NaN
      : new Date(invoice.expires_at).getTime();

    if (!Number.isFinite(expiryMs)) {
      return { nextStatus: "review_required", reasonType: REVIEW_REASON_CODES.OTHER, reasonLabel: "invalid_invoice_expiry" };
    }
    if (!Number.isFinite(blockTimestampMs)) {
      return {
        nextStatus: "review_required",
        reasonType: PAYMENT_CONTRACT_REASON_CODES.TIMESTAMP_UNVERIFIED,
        reasonLabel: PAYMENT_CONTRACT_REASON_CODES.TIMESTAMP_UNVERIFIED,
      };
    }
    if (blockTimestampMs > expiryMs) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.LATE_PAYMENT,
        reasonLabel: "late_arrival_after_expiry",
      };
    }

    if (String(invoice.status ?? "").trim().toLowerCase() === "expired") {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.OTHER,
        reasonLabel: "detected_after_expiry",
      };
    }
    const eventChainId = normalizeChainId(event?.chain_id ?? event?.chainId);
    const invoiceChainId = normalizeChainId(invoice?.chain_id ?? invoice?.chainId);
    if (eventChainId == null || invoiceChainId == null || eventChainId !== invoiceChainId) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.CHAIN_INCONSISTENT,
        reasonLabel: "wrong_chain",
      };
    }
    if (String(event.token_contract ?? "").trim().toLowerCase()
      !== String(invoice.token_contract ?? "").trim().toLowerCase()) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.UNKNOWN_TRANSFER,
        reasonLabel: "wrong_token",
      };
    }
    if (String(event.to_address ?? "").trim().toLowerCase()
      !== String(invoice.recipient_address ?? "").trim().toLowerCase()) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.ADDRESS_MISMATCH,
        reasonLabel: "wrong_recipient",
      };
    }
    const canonicalState = normalizeCanonicalState(
      options.canonicalStatus
      ?? options.canonical
      ?? event?.canonical_status
      ?? event?.canonical
      ?? event?.is_canonical
    );
    if (canonicalState === false) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.CHAIN_INCONSISTENT,
        reasonLabel: "non_canonical_transfer",
      };
    }
    if (canonicalState == null) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.CHAIN_INCONSISTENT,
        reasonLabel: "canonicality_unverified",
      };
    }

    const primaryTransferIdentity = resolvePrimaryTransferIdentity(invoice, options);
    const eventAlreadyRecorded = options.eventAlreadyRecorded === true
      || (primaryTransferIdentity != null && identityInfo.identity === primaryTransferIdentity);
    if (isFinalInvoice(invoice) && !eventAlreadyRecorded) {
      return {
        nextStatus: "review_required",
        reasonType: REVIEW_REASON_CODES.DUPLICATE_PAYMENT,
        reasonLabel: "duplicate_after_primary_transfer",
      };
    }

    const previousPaidBase = previousPaidBaseResult.value;
    const totalPaidBase = totalPaidBaseResult.value != null
      ? totalPaidBaseResult.value
      : (BigInt(previousPaidBase) + (eventAlreadyRecorded ? 0n : BigInt(amountBase))).toString();
    const confirmations = Number(event.confirmations ?? 0);
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
