/**
 * Pure payment decision logic — no DB, no env globals.
 * Instantiate with makePaymentLogic() so tests can control scale and confirmations.
 */
import { compareBaseUnits, parseDecimalToBaseUnits, scaleToDecimals } from "./amounts.mjs";
import { REVIEW_REASON_CODES } from "./reason-codes.mjs";

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

  return { toBaseUnits, decidePaymentStatus };
}
