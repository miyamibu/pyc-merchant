export const PAYMENT_RAIL_TYPES = {
  WALLET_DIRECT: "wallet_direct",
  PROVIDER_EXTERNAL: "provider_external",
};

export const PAYMENT_SESSION_STATUSES = {
  CREATED: "created",
  PRESENTED: "presented",
  ACCEPTED: "accepted",
  FAILED: "failed",
  CANCELLED: "cancelled",
  SETTLEMENT_PENDING: "settlement_pending",
  SETTLED: "settled",
  DISPUTED: "disputed",
};

export const FULFILLMENT_DECISIONS = {
  NONE: "none",
  ALLOW_FULFILLMENT: "allow_fulfillment",
  HOLD: "hold",
};

export const PROVIDER_CODES = {
  SELF_WALLET: "self_wallet",
  MOCK_PROVIDER: "mock_provider",
  MYNA_WALLET_STERA: "myna_wallet_stera",
};

export function isKnownPaymentRailType(value) {
  return Object.values(PAYMENT_RAIL_TYPES).includes(String(value || ""));
}

export function isKnownPaymentSessionStatus(value) {
  return Object.values(PAYMENT_SESSION_STATUSES).includes(String(value || ""));
}

export function isKnownFulfillmentDecision(value) {
  return Object.values(FULFILLMENT_DECISIONS).includes(String(value || ""));
}

export function isKnownProviderCode(value) {
  return Object.values(PROVIDER_CODES).includes(String(value || ""));
}
