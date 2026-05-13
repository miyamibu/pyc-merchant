export const PROVIDER_PRIVATE_FIELDS = [
  "my_number",
  "jpk_i_certificate",
  "jpki_certificate",
  "certificate",
  "raw_certificate",
  "name",
  "full_name",
  "address",
  "birthdate",
  "birth_date",
  "date_of_birth",
  "payer_id",
  "payer_ref",
  "payer_ref_hash",
  "personal_id",
  "identity",
  "credential_subject",
  "credentialsubject",
  "vendor_identity",
  "identity_subject",
];

export const PROVIDER_EVENT_ALLOWED_FIELDS = [
  "provider_code",
  "provider_event_id",
  "provider_session_id",
  "provider_payment_id",
  "invoice_id",
  "terminal_id",
  "event_type",
  "provider_status",
  "amount_jpyc_base",
  "occurred_at",
  "tx_hash",
  "provider_settlement_id",
  "batch_reference",
  "payload_hash",
];

export const PROVIDER_SETTLEMENT_ALLOWED_FIELDS = [
  "provider_code",
  "provider_settlement_id",
  "batch_reference",
  "settlement_status",
  "settlement_amount_jpyc_base",
  "settlement_currency",
  "reported_at",
  "settled_at",
  "payload_hash",
  "tx_hash",
  "allocations",
];

export const PROVIDER_SETTLEMENT_ALLOCATION_ALLOWED_FIELDS = [
  "provider_payment_id",
  "invoice_id",
  "allocated_amount_jpyc_base",
  "allocation_status",
];

export const PROVIDER_EVENT_TYPES = [
  "session_created",
  "authorized",
  "captured",
  "failed",
  "voided",
  "refund_accepted",
  "settlement_reported",
];

export const PROVIDER_PAYMENT_SESSION_STATUSES = [
  "initialized",
  "authorized",
  "captured",
  "failed",
  "voided",
  "refund_accepted",
  "settlement_pending",
  "settled",
  "disputed",
];

export const PROVIDER_SETTLEMENT_STATUSES = [
  "pending",
  "reported",
  "chain_detected",
  "confirmed",
  "failed",
  "disputed",
];

export const PROVIDER_ALLOCATION_STATUSES = [
  "reported",
  "matched",
  "disputed",
];

export function pickAllowedFields(payload, allowedFields) {
  const result = {};
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(payload || {}, key)) {
      result[key] = payload[key];
    }
  }
  return result;
}

export function findPrivateProviderField(value, prefix = "") {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const canonicalKey = String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
    const compactKey = canonicalKey.replace(/_/g, "");
    if (PROVIDER_PRIVATE_FIELDS.includes(canonicalKey) || PROVIDER_PRIVATE_FIELDS.includes(compactKey)) {
      return path;
    }
    if (Array.isArray(nested)) {
      for (let index = 0; index < nested.length; index += 1) {
        const found = findPrivateProviderField(nested[index], `${path}[${index}]`);
        if (found) return found;
      }
      continue;
    }
    if (nested && typeof nested === "object") {
      const found = findPrivateProviderField(nested, path);
      if (found) return found;
    }
  }
  return null;
}

export function canonicalReceivableStatus(providerStatus, settlementStatus = null) {
  const provider = String(providerStatus || "").trim().toLowerCase();
  const settlement = String(settlementStatus || "").trim().toLowerCase();
  if (provider === "authorized") return "provider_accepted";
  if (provider === "captured") return "provider_captured";
  if (["reported", "pending", "chain_detected"].includes(settlement) || provider === "settlement_pending") {
    return "settlement_reported";
  }
  if (provider === "disputed" || settlement === "disputed") return "disputed";
  return "none";
}

export function providerEventAllowsFulfillment(eventType, providerStatus) {
  const eventName = String(eventType || "").trim().toLowerCase();
  const status = String(providerStatus || "").trim().toLowerCase();
  return eventName === "authorized" || eventName === "captured" || status === "authorized" || status === "captured";
}
