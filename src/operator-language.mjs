export const JAPANESE_FONT_STACK = [
  '"Noto Sans JP"',
  '"Noto Sans CJK JP"',
  '"Hiragino Sans"',
  '"Yu Gothic"',
  '"Meiryo"',
  "system-ui",
  "-apple-system",
  "BlinkMacSystemFont",
  "sans-serif",
].join(", ");

export const INVOICE_STATUS_ALIASES = Object.freeze({
  manual_review: "review_required",
  pending: "issued",
  open: "issued",
});

export function normalizeInvoiceStatus(status) {
  const raw = String(status || "").trim();
  if (!raw) return "issued";
  return INVOICE_STATUS_ALIASES[raw] || raw;
}

export const OPERATOR_STATUS_POLICY = Object.freeze({
  issued: {
    statusLabel: "お支払い待ち",
    handoffBadge: "まだ渡さない",
    handoffDecision: "商品引渡し: まだ渡さない",
    nextAction: "お客様にこの会計のQRを読み取ってもらい、支払い確認済みになるまで待ちます。",
    managerAction: "店長確認: 不要。期限切れ・送金後に止まった場合だけ呼びます。",
    customerScript: "このQRを読み取り、画面の金額と送金先を確認して送金してください。",
  },
  payment_detected: {
    statusLabel: "確認中",
    handoffBadge: "まだ渡さない",
    handoffDecision: "商品引渡し: まだ渡さない",
    nextAction: "送金検知済みです。追加送金を促さず、支払い確認済みになるまで待ちます。",
    managerAction: "店長確認: 長く止まる場合だけ呼びます。",
    customerScript: "送金は受け付けています。二重送金せず、この画面の更新をお待ちください。",
  },
  confirming: {
    statusLabel: "確認中",
    handoffBadge: "まだ渡さない",
    handoffDecision: "商品引渡し: まだ渡さない",
    nextAction: "確認処理中です。画面を更新せず、自動更新を待ちます。",
    managerAction: "店長確認: 長く止まる場合だけ呼びます。",
    customerScript: "確認中です。追加で送金せず、そのままお待ちください。",
  },
  paid: {
    statusLabel: "支払い確認済み",
    handoffBadge: "渡してOK",
    handoffDecision: "商品引渡し: 渡してOK",
    nextAction: "商品を渡してよい状態です。次の会計へ進めます。",
    managerAction: "店長確認: 不要。",
    customerScript: "お支払いを確認しました。ありがとうございます。",
  },
  review_required: {
    statusLabel: "店長確認が必要",
    handoffBadge: "店長確認まで保留",
    handoffDecision: "商品引渡し: 店長確認まで保留",
    nextAction: "追加送金を促さず、店長または管理者を呼びます。",
    managerAction: "店長確認: 必要。確認待ち一覧で理由と取引番号を確認します。",
    customerScript: "お支払い内容を確認します。追加で送金せず、この画面をスタッフに見せてください。",
  },
  expired: {
    statusLabel: "期限切れ",
    handoffBadge: "新しい請求が必要",
    handoffDecision: "商品引渡し: まだ渡さない",
    nextAction: "古い画面から送金しないよう案内し、新しい請求を作成します。",
    managerAction: "店長確認: 期限後に送金済みの場合は必要。",
    customerScript: "この請求は期限切れです。送金せず、新しい請求をお待ちください。",
  },
  settled: {
    statusLabel: "締め反映済み",
    handoffBadge: "渡してOK",
    handoffDecision: "商品引渡し: 渡してOK",
    nextAction: "追加操作は不要です。会計・締めの記録に反映済みです。",
    managerAction: "店長確認: 不要。",
    customerScript: "お支払いは確認済みです。",
  },
  cancelled: {
    statusLabel: "無効",
    handoffBadge: "無効",
    handoffDecision: "商品引渡し: まだ渡さない",
    nextAction: "この請求は使わず、新しい請求を作成するか別決済へ切り替えます。",
    managerAction: "店長確認: 送金済みの申告がある場合は必要。",
    customerScript: "この請求は無効です。送金せず、スタッフの案内をお待ちください。",
  },
});

export function getOperatorStatusPolicy(status) {
  return OPERATOR_STATUS_POLICY[normalizeInvoiceStatus(status)] || OPERATOR_STATUS_POLICY.issued;
}

export const REVIEW_REASON_ACTION_POLICY = Object.freeze({
  UNDERPAYMENT: {
    title: "不足入金が発生しました",
    suggestedAction: "不足額はこの請求への追加送金では受け付けません。店長承認後に別の新規請求を作るか、会計調整として処理します。",
    safeExit: "元の請求額は変更せず、同じ請求への追加入金を促しません。別の新規請求は店長承認後に発行します。",
  },
  OVERPAYMENT: {
    title: "過入金が発生しました",
    suggestedAction: "有効な売上額を確認し、差額の返金ケースを作成します。",
    safeExit: "アプリは返金送金を実行しません。店舗ウォレットで返金後、tx hash を登録します。",
  },
  DUPLICATE_PAYMENT: {
    title: "重複支払いが発生しました",
    suggestedAction: "1件を有効な売上として残し、重複分の返金ケースを作成します。",
    safeExit: "確認できた全ての取引番号を証跡に残します。",
  },
  SPLIT_PAYMENT: {
    title: "分割支払いが発生しました",
    suggestedAction: "不足または過入金の合算状況を確認し、店長判断で処理します。",
    safeExit: "自動で売上確定せず、確認待ちに残します。",
  },
  LATE_PAYMENT: {
    title: "期限後に支払いが届きました",
    suggestedAction: "同じ会計の新しい請求が支払い済みか確認し、重複/旧請求として処理します。",
    safeExit: "兄弟請求と商品提供状況を確認するまで商品引渡しを保留します。",
  },
  ADDRESS_MISMATCH: {
    title: "送金先が一致しません",
    suggestedAction: "自動確定せず、診断証跡を保存して管理者判断に回します。",
    safeExit: "返金可否は取引明細と送金先を確認してから判断します。",
  },
  UNKNOWN_TRANSFER: {
    title: "送金条件が一致しません",
    suggestedAction: "チェーン・トークン・金額・送金元を確認し、管理者判断に回します。",
    safeExit: "自動確定しません。証跡を残して対応します。",
  },
  CHAIN_INCONSISTENT: {
    title: "ネットワークが一致しません",
    suggestedAction: "対応ネットワーク外の可能性があるため、自動確定せず管理者判断に回します。",
    safeExit: "診断証跡を保存し、返金可否を別途判断します。",
  },
  LEDGER_INTEGRITY_ERROR: {
    title: "会計台帳の整合性を確認してください",
    suggestedAction: "元の台帳値を変更せず、支払い証跡と会計記録を管理者が照合します。",
    safeExit: "整合性確認が終わるまで商品引渡し・返金・締めを進めません。",
  },
});

export function normalizeReviewReason(reason) {
  const raw = String(reason || "").trim().toUpperCase();
  if (!raw) return "OTHER";
  const aliases = {
    SHORTAGE: "UNDERPAYMENT",
    OVERPAY: "OVERPAYMENT",
    DUPLICATE: "DUPLICATE_PAYMENT",
    LATE_ARRIVAL: "LATE_PAYMENT",
    WRONG_RECIPIENT: "ADDRESS_MISMATCH",
    WRONG_CHAIN: "CHAIN_INCONSISTENT",
    WRONG_TOKEN: "UNKNOWN_TRANSFER",
  };
  return aliases[raw] || raw;
}

export function getReviewReasonActionPolicy(reason) {
  const normalized = normalizeReviewReason(reason);
  return REVIEW_REASON_ACTION_POLICY[normalized] || {
    title: "確認が必要な支払いです",
    suggestedAction: "取引番号、請求額、着金額、商品提供状況を確認して管理者判断に回します。",
    safeExit: "自動確定せず、担当者メモと証跡を残します。",
  };
}

export const FORBIDDEN_STORE_CUSTOMER_TERMS = Object.freeze([
  "review_required",
  "manual_review",
  "atomic amount",
  "token_contract",
  "RPC",
  "worker",
  "秘密鍵を入力",
  "シードフレーズを入力",
]);

export function hasTofuGlyphs(text) {
  return /[□�]/.test(String(text || ""));
}
