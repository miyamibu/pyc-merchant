const ACTIVE_PAYMENT_STATUSES = new Set(["issued", "payment_detected", "confirming"]);
const PAYMENT_STATUS_VALUES = new Set(["issued", "detected", "partially_paid", "confirming", "paid", "expired", "cancelled"]);
const FULFILLMENT_STATUS_VALUES = new Set(["hold", "allowed", "delivered"]);
const REVIEW_STATUS_VALUES = new Set(["none", "open", "in_progress", "resolved", "rejected"]);
const INTEGRITY_STATUS_VALUES = new Set(["ok", "hold", "disputed"]);
const ACCOUNTING_STATUS_VALUES = new Set(["unrecognized", "recognized", "adjusted", "closed"]);
const REFUND_STATUS_VALUES = new Set(["none", "requested", "approved", "sent", "verified", "finalized", "failed", "hold"]);

function explicitAxis(input, key, allowed, forceLegacy) {
  if (forceLegacy) return null;
  const value = String(input?.[key] ?? "").trim().toLowerCase();
  return allowed.has(value) ? value : null;
}

export function deriveInvoiceStateAxes(invoice = {}) {
  const status = String(invoice.status || "").trim().toLowerCase();
  const forceLegacy = invoice._force_legacy_state_axes === true;
  const billedBase = String(invoice.ledger_amount_base ?? invoice.amount_jpyc_base ?? "").trim();
  const paidBase = String(invoice.paid_amount_jpyc_base ?? "0").trim();
  const hasPartialPayment = /^\d+$/.test(billedBase)
    && /^\d+$/.test(paidBase)
    && BigInt(paidBase) > 0n
    && BigInt(paidBase) < BigInt(billedBase);
  const integrityHeld = Number(invoice.integrity_hold || 0) === 1
    || ["hold", "held"].includes(String(invoice.integrity_status || "").toLowerCase());
  const integrityStatus = String(invoice.integrity_status || "").trim().toLowerCase();
  const reviewStatus = String(invoice.review_status || "").trim().toLowerCase();
  const refundStatus = String(invoice.refund_status || "").trim().toLowerCase() || "none";
  const derivedPaymentStatus = status === "settled"
    ? "paid"
    : status === "paid"
      ? "paid"
      : hasPartialPayment
        ? "partially_paid"
      : status === "review_required"
        ? (hasPartialPayment ? "partially_paid" : /^\d+$/.test(paidBase) && BigInt(paidBase) > 0n ? "paid" : "detected")
        : status || "unknown";
  const derivedFulfillmentStatus = String(invoice.fulfillment_status || "") === "delivered"
    ? "delivered"
    : integrityHeld || status === "review_required"
    ? "hold"
    : ["paid", "settled"].includes(status)
      ? "allowed"
      : "hold";
  const derivedAccountingStatus = status === "settled"
    ? "closed"
    : status === "paid"
      ? "recognized"
      : status === "review_required"
        ? "adjusted"
        : "unrecognized";
  const monitoringStatus = integrityHeld
    ? "integrity_hold"
    : ["paid", "settled"].includes(status)
      ? "post_payment"
      : ACTIVE_PAYMENT_STATUSES.has(status) || status === "review_required"
        ? "active"
        : "inactive";

  const derivedReviewStatus = reviewStatus || (status === "review_required" ? "open" : "none");
  const derivedIntegrityStatus = integrityHeld ? "hold" : integrityStatus === "disputed" ? "disputed" : "ok";
  return {
    payment_status: explicitAxis(invoice, "payment_status", PAYMENT_STATUS_VALUES, forceLegacy) || derivedPaymentStatus,
    fulfillment_status: explicitAxis(invoice, "fulfillment_status", FULFILLMENT_STATUS_VALUES, forceLegacy) || derivedFulfillmentStatus,
    review_status: explicitAxis(invoice, "review_status", REVIEW_STATUS_VALUES, forceLegacy) || derivedReviewStatus,
    integrity_status: explicitAxis(invoice, "integrity_status", INTEGRITY_STATUS_VALUES, forceLegacy) || derivedIntegrityStatus,
    accounting_status: explicitAxis(invoice, "accounting_status", ACCOUNTING_STATUS_VALUES, forceLegacy) || derivedAccountingStatus,
    refund_status: explicitAxis(invoice, "refund_status", REFUND_STATUS_VALUES, forceLegacy) || refundStatus,
    monitoring_status: monitoringStatus,
  };
}
