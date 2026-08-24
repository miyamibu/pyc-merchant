export const REVIEW_REASON_CODES = Object.freeze({
  OVERPAYMENT: "OVERPAYMENT",
  UNDERPAYMENT: "UNDERPAYMENT",
  DUPLICATE_PAYMENT: "DUPLICATE_PAYMENT",
  SPLIT_PAYMENT: "SPLIT_PAYMENT",
  LATE_PAYMENT: "LATE_PAYMENT",
  UNKNOWN_TRANSFER: "UNKNOWN_TRANSFER",
  ADDRESS_MISMATCH: "ADDRESS_MISMATCH",
  CHAIN_INCONSISTENT: "CHAIN_INCONSISTENT",
  CHAIN_REORG: "CHAIN_REORG",
  LEDGER_INTEGRITY_ERROR: "LEDGER_INTEGRITY_ERROR",
  CHAIN_TRANSFER_IDENTITY_INCOMPLETE: "CHAIN_TRANSFER_IDENTITY_INCOMPLETE",
  TIMESTAMP_UNVERIFIED: "TIMESTAMP_UNVERIFIED",
  DETECTED_AFTER_EXPIRY: "DETECTED_AFTER_EXPIRY",
  CROSS_INVOICE_TRANSFER_COLLISION: "CROSS_INVOICE_TRANSFER_COLLISION",
  OTHER: "OTHER",
});

export const LEGACY_REVIEW_REASON_CODE_MAP = Object.freeze({
  shortage: REVIEW_REASON_CODES.UNDERPAYMENT,
  underpayment: REVIEW_REASON_CODES.UNDERPAYMENT,
  overpay: REVIEW_REASON_CODES.OVERPAYMENT,
  overpayment: REVIEW_REASON_CODES.OVERPAYMENT,
  duplicate: REVIEW_REASON_CODES.DUPLICATE_PAYMENT,
  duplicate_payment: REVIEW_REASON_CODES.DUPLICATE_PAYMENT,
  split: REVIEW_REASON_CODES.SPLIT_PAYMENT,
  split_payment: REVIEW_REASON_CODES.SPLIT_PAYMENT,
  late_arrival: REVIEW_REASON_CODES.LATE_PAYMENT,
  late_payment: REVIEW_REASON_CODES.LATE_PAYMENT,
  wrong_chain: REVIEW_REASON_CODES.CHAIN_INCONSISTENT,
  chain_inconsistent: REVIEW_REASON_CODES.CHAIN_INCONSISTENT,
  chain_reorg: REVIEW_REASON_CODES.CHAIN_REORG,
  chain_reorg_detected: REVIEW_REASON_CODES.CHAIN_REORG,
  ledger_integrity_error: REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR,
  chain_transfer_identity_incomplete: REVIEW_REASON_CODES.CHAIN_TRANSFER_IDENTITY_INCOMPLETE,
  timestamp_unverified: REVIEW_REASON_CODES.TIMESTAMP_UNVERIFIED,
  detected_after_expiry: REVIEW_REASON_CODES.DETECTED_AFTER_EXPIRY,
  cross_invoice_transfer_collision: REVIEW_REASON_CODES.CROSS_INVOICE_TRANSFER_COLLISION,
  wrong_token: REVIEW_REASON_CODES.UNKNOWN_TRANSFER,
  unknown_transfer: REVIEW_REASON_CODES.UNKNOWN_TRANSFER,
  wrong_recipient: REVIEW_REASON_CODES.ADDRESS_MISMATCH,
  address_mismatch: REVIEW_REASON_CODES.ADDRESS_MISMATCH,
  invalid_invoice_expiry: REVIEW_REASON_CODES.OTHER,
  invalid_invoice_amount: REVIEW_REASON_CODES.OTHER,
  invalid_amount: REVIEW_REASON_CODES.OTHER,
  invalid_event_amount: REVIEW_REASON_CODES.OTHER,
  invalid_observed_at: REVIEW_REASON_CODES.OTHER,
  payments_disabled: REVIEW_REASON_CODES.OTHER,
  other: REVIEW_REASON_CODES.OTHER,
});

const KNOWN_REASON_CODES = new Set(Object.values(REVIEW_REASON_CODES));

export function normalizeReviewReasonCode(rawValue, fallback = REVIEW_REASON_CODES.OTHER) {
  const raw = String(rawValue || "").trim();
  if (!raw) return fallback;
  const upper = raw.toUpperCase();
  if (KNOWN_REASON_CODES.has(upper)) return upper;
  const lower = raw.toLowerCase();
  return LEGACY_REVIEW_REASON_CODE_MAP[lower] || fallback;
}

export function isRefundCandidateReasonCode(reasonCodeRaw) {
  const code = normalizeReviewReasonCode(reasonCodeRaw);
  return [
    REVIEW_REASON_CODES.OVERPAYMENT,
    REVIEW_REASON_CODES.DUPLICATE_PAYMENT,
    REVIEW_REASON_CODES.LATE_PAYMENT,
    REVIEW_REASON_CODES.UNKNOWN_TRANSFER,
    REVIEW_REASON_CODES.ADDRESS_MISMATCH,
    REVIEW_REASON_CODES.CHAIN_INCONSISTENT,
  ].includes(code);
}

export function reasonCodeLabelJa(reasonCodeRaw) {
  const code = normalizeReviewReasonCode(reasonCodeRaw);
  const labels = {
    [REVIEW_REASON_CODES.OVERPAYMENT]: "金額が多く支払われています",
    [REVIEW_REASON_CODES.UNDERPAYMENT]: "金額が不足しています",
    [REVIEW_REASON_CODES.DUPLICATE_PAYMENT]: "同じ請求に追加の支払いが届きました",
    [REVIEW_REASON_CODES.SPLIT_PAYMENT]: "同じ請求に追加の支払いが届きました",
    [REVIEW_REASON_CODES.LATE_PAYMENT]: "期限後に支払いが届きました",
    [REVIEW_REASON_CODES.UNKNOWN_TRANSFER]: "請求との照合が必要です",
    [REVIEW_REASON_CODES.ADDRESS_MISMATCH]: "送金先が請求内容と一致しません",
    [REVIEW_REASON_CODES.CHAIN_INCONSISTENT]: "チェーンまたはトークンが一致しません",
    [REVIEW_REASON_CODES.CHAIN_REORG]: "チェーン再編成により再確認が必要です",
    [REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR]: "会計台帳の整合性確認が必要です",
    [REVIEW_REASON_CODES.CHAIN_TRANSFER_IDENTITY_INCOMPLETE]: "送金識別情報が不足しているため確定できません",
    [REVIEW_REASON_CODES.TIMESTAMP_UNVERIFIED]: "ブロック時刻を検証できないため確定できません",
    [REVIEW_REASON_CODES.DETECTED_AFTER_EXPIRY]: "期限後に検知されたため提供可否の確認が必要です",
    [REVIEW_REASON_CODES.CROSS_INVOICE_TRANSFER_COLLISION]: "同じチェーン送金が複数請求に関連付いています",
    [REVIEW_REASON_CODES.OTHER]: "確認が必要な支払い",
  };
  return labels[code] || labels[REVIEW_REASON_CODES.OTHER];
}

export function suggestedReviewAction(reasonCodeRaw) {
  const code = normalizeReviewReasonCode(reasonCodeRaw);
  const actions = {
    [REVIEW_REASON_CODES.OVERPAYMENT]: "差額を確認し、返金候補額を検討してください",
    [REVIEW_REASON_CODES.UNDERPAYMENT]: "不足額は同じ請求への追加送金では受け付けず、店長承認後の別請求または会計調整を判断してください",
    [REVIEW_REASON_CODES.DUPLICATE_PAYMENT]: "重複分の返金可否を確認してください",
    [REVIEW_REASON_CODES.SPLIT_PAYMENT]: "分割送金として整合確認を実施してください",
    [REVIEW_REASON_CODES.LATE_PAYMENT]: "期限後着金として提供状況と返金要否を確認してください",
    [REVIEW_REASON_CODES.UNKNOWN_TRANSFER]: "送金元・送金先・金額の照合を実施してください",
    [REVIEW_REASON_CODES.ADDRESS_MISMATCH]: "請求先アドレスとの不一致を確認してください",
    [REVIEW_REASON_CODES.CHAIN_INCONSISTENT]: "チェーンとトークンを確認し、誤送金対応を実施してください",
    [REVIEW_REASON_CODES.CHAIN_REORG]: "再編成後の正規チェーン記録を再確認するまで提供・返金・締めを停止してください",
    [REVIEW_REASON_CODES.LEDGER_INTEGRITY_ERROR]: "元の台帳値を変更せず、管理者が会計証跡を照合してください",
    [REVIEW_REASON_CODES.CHAIN_TRANSFER_IDENTITY_INCOMPLETE]: "chain_id・tx_hash・log_indexを再取得するまで確定・提供・締めを停止してください",
    [REVIEW_REASON_CODES.TIMESTAMP_UNVERIFIED]: "検証済みブロック時刻を取得するまで期限判定を行わないでください",
    [REVIEW_REASON_CODES.DETECTED_AFTER_EXPIRY]: "ブロック時刻と検知時刻を照合し、提供可否を手動確認してください",
    [REVIEW_REASON_CODES.CROSS_INVOICE_TRANSFER_COLLISION]: "関連する全請求を保留し、送金と請求の紐付けを再確認してください",
    [REVIEW_REASON_CODES.OTHER]: "管理者確認が必要です",
  };
  return actions[code] || actions[REVIEW_REASON_CODES.OTHER];
}
