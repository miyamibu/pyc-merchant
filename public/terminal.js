// A paid invoice remains observable because the chain-monitor can discover a
// later reorg and set an integrity hold directly in SQLite. Closing the stream
// at `paid` would leave the operator's "商品を渡してOK" banner stale.
const ACTIVE_INVOICE_STATUSES = new Set([
  "issued",
  "payment_detected",
  "confirming",
  "paid",
  "settled",
  "review_required",
  "expired",
  "refunded",
]);
const FINAL_INVOICE_STATUSES = new Set(["cancelled"]);
const INVOICE_STATUS_ALIASES = Object.freeze({
  manual_review: "review_required",
});
const FALLBACK_POLL_INTERVAL_MS = 10_000;
const FULFILLMENT_FRESHNESS_MS = 30_000;
const API_REQUEST_TIMEOUT_MS = 15_000;
const API_EXPORT_REQUEST_TIMEOUT_MS = 45_000;
const LEGACY_SETTINGS_KEY = "jpyc_terminal_settings";
const SETTINGS_NAMESPACE = `${LEGACY_SETTINGS_KEY}:v2`;
const SETTINGS_SCHEMA_VERSION = 2;
const volatileSettingsStorage = new Map();
let settingsStorageWarningShown = false;
const DEFAULT_AMOUNT_PRESETS = Object.freeze([500, 1000, 3000, 5000, 10000]);
const DEFAULT_TERMINAL_SETTINGS = Object.freeze({
  volume: 0.8,
  auto_reset_sec: 120,
  amount_presets: DEFAULT_AMOUNT_PRESETS,
});
const MAX_AMOUNT_PRESET_COUNT = 12;
const REVIEW_STATUS_SORT_ORDER = Object.freeze({
  open: 0,
  in_progress: 1,
  resolved: 2,
  rejected: 3,
});
const REVIEW_REASON_PRIORITY_ORDER = Object.freeze({
  DUPLICATE_PAYMENT: 0,
  OVERPAYMENT: 0,
  UNKNOWN_TRANSFER: 0,
  CHAIN_INCONSISTENT: 0,
  CHAIN_REORG: 0,
  LEDGER_INTEGRITY_ERROR: 0,
  ADDRESS_MISMATCH: 0,
  LATE_PAYMENT: 1,
  UNDERPAYMENT: 2,
  SPLIT_PAYMENT: 2,
  OTHER: 3,
});
const REFUND_CANDIDATE_REASONS = new Set([
  "DUPLICATE_PAYMENT",
  "OVERPAYMENT",
  "LATE_PAYMENT",
  "UNKNOWN_TRANSFER",
  "CHAIN_INCONSISTENT",
  "ADDRESS_MISMATCH",
]);
const REFUND_VERIFY_RETRYABLE_STATUSES = new Set([
  "recorded",
  "pending_verification",
  "verification_failed",
  "failed",
]);
const ADDRESS_POOL_WARN_THRESHOLD = 5;
const WORKER_STALE_WARN_SEC = 300;
const OPS_AUTO_REFRESH_INTERVAL_MS = 60_000;
const PROVIDER_RAIL_ENABLED = document.body?.dataset.providerRailEnabled === "true";
const ADMIN_UI_PERMISSIONS = Object.freeze([
  "review.read",
  "review.update",
  "accounting.adjustment.read",
  "accounting.adjustment.create",
  "accounting.adjustment.approve",
  "refund.request",
  "refund.view",
  "refund.approve",
  "refund.execute",
  "settlement.close",
  "settlement.export",
  "audit.read",
  "audit.export",
  "monitor.read",
]);
const WALLET_SCOPED_CAPABILITY_PREFIX = /^(?:検証済み環境（[^）]*(?:iOS|Android)[^）]*ウォレット[^）]*）|起動導線あり(?:（[^）]*）)?|手動送金のみ|未検証(?:（[^）]*）)?):\s*/;
const WALLET_BROAD_TESTED_PREFIX = /^実機検証済み:\s*(.+)$/;

const storePaymentsControlTemplate = document.getElementById("storePaymentsControlTemplate");
const STORE_PAYMENTS_CONTROL_MARKUP = storePaymentsControlTemplate?.innerHTML.trim() || "";
storePaymentsControlTemplate?.remove();
const adminOperationsTemplate = document.getElementById("adminOperationsTemplate");
const ADMIN_OPERATIONS_MARKUP = adminOperationsTemplate?.innerHTML.trim() || "";
adminOperationsTemplate?.remove();

if (!PROVIDER_RAIL_ENABLED) {
  document.querySelectorAll("[data-provider-rail]").forEach((node) => node.remove());
}

function normalizeReviewReason(reasonType) {
  const raw = String(reasonType || "").trim();
  if (!raw) return "OTHER";
  const upper = raw.toUpperCase();
  if (upper === "SHORTAGE") return "UNDERPAYMENT";
  if (upper === "OVERPAY") return "OVERPAYMENT";
  if (upper === "LATE_ARRIVAL") return "LATE_PAYMENT";
  if (upper === "DUPLICATE") return "DUPLICATE_PAYMENT";
  if (upper === "WRONG_CHAIN") return "CHAIN_INCONSISTENT";
  if (upper === "WRONG_TOKEN") return "UNKNOWN_TRANSFER";
  if (upper === "WRONG_RECIPIENT") return "ADDRESS_MISMATCH";
  if (upper === "INVALID_INVOICE_EXPIRY") return "OTHER";
  return upper;
}

function canonicalInvoiceStatus(status) {
  const raw = String(status || "").trim();
  if (!raw) return "";
  return INVOICE_STATUS_ALIASES[raw] || raw;
}

function hasIntegrityHold(invoice) {
  if (!invoice) return false;
  const integrityHold = invoice.integrity_hold;
  const explicitHold = integrityHold === true
    || ["active", "hold", "integrity_hold"].includes(String(integrityHold || "").toLowerCase())
    || (integrityHold && typeof integrityHold === "object"
      && (integrityHold.active === true || ["active", "hold"].includes(String(integrityHold.status || "").toLowerCase())));
  const rawFulfillmentDecision = invoice.fulfillment_decision;
  const fulfillmentDecision = rawFulfillmentDecision && typeof rawFulfillmentDecision !== "object"
    ? String(rawFulfillmentDecision).toLowerCase()
    : "";
  const statusReason = String(invoice.status_reason || "").toLowerCase();
  return explicitHold
    || ["hold", "hold_fulfillment", "deny_fulfillment", "integrity_hold"].includes(fulfillmentDecision)
    || ["integrity_hold", "reorg_detected", "chain_reorg", "reorg_integrity_hold"].includes(statusReason);
}

function getAuthoritativeFulfillmentDecision(invoice) {
  const raw = invoice?.fulfillment_decision;
  const providerFallback = invoice?.provider_summary?.fulfillment_decision;
  const candidate = raw && typeof raw === "object"
    ? raw
    : providerFallback && typeof providerFallback === "object"
      ? providerFallback
      : null;
  if (!candidate) {
    return {
      decision: "hold",
      reason_codes: ["FULFILLMENT_DECISION_UNAVAILABLE"],
    };
  }
  const decision = String(candidate.decision || "").trim().toLowerCase();
  return {
    ...candidate,
    decision: ["allow", "allow_fulfillment"].includes(decision) ? "allow" : "hold",
  };
}

function effectiveOperatorStatus(invoice) {
  if (hasIntegrityHold(invoice)) return "integrity_hold";
  return canonicalInvoiceStatus(invoice?.status) || "idle";
}

function getOperatorActionPolicy(status) {
  const map = {
    idle: {
      label: "会計準備",
      handoff: "商品引渡し: まだ渡さない",
      next: "次にやること: 金額を入力して請求を作成します。",
      manager: "店長確認: 不要。",
      script: "お客様への一言: 会計を準備しています。少々お待ちください。",
      action: "請求作成",
    },
    issued: {
      label: "お支払い待ち",
      handoff: "商品引渡し: まだ渡さない",
      next: "次にやること: お客様にこの会計のQRを読み取ってもらい、支払い確認済みになるまで待ちます。",
      manager: "店長確認: 不要。期限切れ・送金後に止まった場合だけ呼びます。",
      script: "お客様への一言: 金額と送金先を確認し、送金後は画面が変わるまでお待ちください。",
      action: "QR提示・確認待ち",
    },
    payment_detected: {
      label: "確認中",
      handoff: "商品引渡し: まだ渡さない",
      next: "次にやること: 追加送金を促さず、自動更新を待ちます。",
      manager: "店長確認: 長く止まる場合だけ呼びます。",
      script: "お客様への一言: 送金は受け付けています。二重送金せずお待ちください。",
      action: "確認待ち",
    },
    confirming: {
      label: "確認中",
      handoff: "商品引渡し: まだ渡さない",
      next: "次にやること: 画面を更新せず、自動更新を待ちます。",
      manager: "店長確認: 長く止まる場合だけ呼びます。",
      script: "お客様への一言: 追加で送金せず、そのままお待ちください。",
      action: "確認待ち",
    },
    paid: {
      label: "支払い確認済み",
      handoff: "商品引渡し: 渡してOK",
      next: "次にやること: 商品を渡し、必要なら確認書を案内します。",
      manager: "店長確認: 不要。",
      script: "お客様への一言: お支払いを確認しました。ありがとうございます。",
      action: "商品渡しOK",
    },
    settled: {
      label: "締め反映済み",
      handoff: "商品引渡し: 渡してOK",
      next: "次にやること: 追加操作はありません。",
      manager: "店長確認: 不要。",
      script: "お客様への一言: お支払いは確認済みです。",
      action: "追加操作不要",
    },
    review_required: {
      label: "店長確認が必要",
      handoff: "商品引渡し: 店長確認まで保留",
      next: "次にやること: 追加送金を促さず、店長または管理者を呼びます。",
      manager: "店長確認: 必要。確認待ち一覧で理由と取引番号を確認します。",
      script: "お客様への一言: お支払い内容を確認します。追加で送金せず、この画面をお見せください。",
      action: "店長確認",
    },
    integrity_hold: {
      label: "記録整合性を確認中",
      handoff: "商品引渡し: 絶対に渡さない",
      next: "次にやること: 追加送金を促さず、自動更新を待って店長または管理者へ引き継ぎます。",
      manager: "店長確認: 必須。記録整合性の保留が解除されるまで会計判断を進めません。",
      script: "お客様への一言: お支払い記録を確認しています。追加で送金せず、そのままお待ちください。",
      action: "商品引渡し保留",
    },
    observation_unavailable: {
      label: "最新状態を再確認中",
      handoff: "商品引渡し: 渡さない",
      next: "次にやること: 自動更新または最新取得が成功するまで待ちます。",
      manager: "店長確認: 再取得できない場合は必要です。",
      script: "お客様への一言: 最新状態を確認しています。追加送金せず、そのままお待ちください。",
      action: "商品引渡し保留",
    },
    expired: {
      label: "期限切れ",
      handoff: "商品引渡し: まだ渡さない",
      next: "次にやること: 古い画面から送金しないよう案内し、新しい請求を作成します。",
      manager: "店長確認: すでに送金した申告がある場合は必要。",
      script: "お客様への一言: この請求は期限切れです。送金せず、新しい請求をお待ちください。",
      action: "新しい請求",
    },
    cancelled: {
      label: "無効",
      handoff: "商品引渡し: まだ渡さない",
      next: "次にやること: 新しい請求を作成するか別決済へ切り替えます。",
      manager: "店長確認: 送金済みの申告がある場合は必要。",
      script: "お客様への一言: この請求は無効です。送金せず、スタッフの案内をお待ちください。",
      action: "新規発行",
    },
  };
  return map[canonicalInvoiceStatus(status) || "idle"] || map.idle;
}

const state = {
  token: "",
  sessionEpoch: 0,
  requestControllers: new Set(),
  terminalId: "",
  storeId: "",
  sessionId: "",
  role: "",
  staffName: "",
  staffCode: "",
  effectivePermissions: new Set(),
  permissionsKnown: false,
  storeTimezone: "Asia/Tokyo",
  sessionExpiresAt: "",
  sessionExpiryTimer: null,
  supportedWallets: [],
  paymentsDisableState: null,
  paymentsReadState: "unknown",
  storePaymentsControlInFlight: false,
  storePaymentsOperation: null,
  paymentChains: [],
  deploymentTopology: "public_cloud",
  fixedQrUrl: "",
  fixedQrToken: "",
  policyOrigin: "",
  policyLinks: null,
  invoiceConsent: null,
  consentRecordingInFlight: false,
  invoiceId: "",
  invoiceStatus: "",
  currentInvoice: null,
  invoiceRequestSequence: 0,
  latestInvoiceRequestId: "",
  diagnosticsEnabled: false,
  invoiceDiagnostics: null,
  diagnosticsUpdatedAt: "",
  sseToken: "",
  sse: null,
  sseStatus: "idle",
  sseReason: "未接続",
  sseUpdatedAt: "",
  lastStreamEventAt: "",
  sseReconnectTimer: null,
  fallbackPollTimer: null,
  fallbackPollingStatus: "idle",
  fallbackPollingReason: "未開始",
  fallbackPollingUpdatedAt: "",
  lastFallbackPollAt: "",
  lastInvoiceRefreshAt: "",
  fulfillmentObservationValid: false,
  fulfillmentFreshnessTimer: null,
  reviewRows: [],
  selectedReviewId: "",
  selectedReviewDetail: null,
  reviewDrafts: new Map(),
  reviewDraftBindingId: "",
  reviewDraftDirty: false,
  pendingReviewUpdate: "",
  reviewListSequence: 0,
  reviewListFilter: "",
  reviewDetailSequence: 0,
  reviewDetailRequestId: "",
  autoRefreshTimer: null,
  opsReviewReadState: "unavailable",
  opsSettlementReadState: "unavailable",
  opsReviewBusinessDate: "",
  opsSnapshotSequence: 0,
  opsSnapshotBusinessDate: "",
  pendingDangerAction: "",
  invoiceOperationsInFlight: new Set(),
  invoiceOperationKeys: new Map(),
  pendingRefundExecute: "",
  pendingRefundExecuteTimer: null,
  pendingSettlementClose: "",
  settlementCloseInFlight: false,
  settlementPreviewInFlight: false,
  settlementOperationKeys: new Map(),
  settlementPreview: null,
  settlementPreviewSignature: "",
  settlementExport: null,
  accountingAdjustmentOperations: new Map(),
  accountingAdjustmentInFlight: new Set(),
  pendingAdjustmentRows: [],
  pendingAdjustmentSelectedId: "",
  refundRequestInFlight: false,
  refundRequestSignature: "",
  refundRequestIdempotencyKey: "",
  refundRequestCompletedSignature: "",
  refundRequestOperations: new Map(),
  refundOperationsInFlight: new Set(),
  refundOperationTargetsInFlight: new Set(),
  refundOperationKeys: new Map(),
  refundReadSequence: 0,
  refundReadRequestId: "",
  currentRefund: null,
  refundPayerAddressVerified: false,
  refundPayerAddressReviewId: "",
  autoResetTimer: null,
  autoResetInvoiceId: "",
  logoutInFlight: false,
  logoutRetryToken: "",
  logoutIdempotencyKey: "",
};

const el = {
  terminalCode: document.getElementById("terminalCode"),
  staffName: document.getElementById("staffName"),
  staffPin: document.getElementById("staffPin"),
  loginFormPanel: document.getElementById("loginFormPanel"),
  loginError: document.getElementById("loginError"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  sessionRolePill: document.getElementById("sessionRolePill"),
  sessionIdentityText: document.getElementById("sessionIdentityText"),
  sessionRoleText: document.getElementById("sessionRoleText"),
  sessionPermissionText: document.getElementById("sessionPermissionText"),
  sessionText: document.getElementById("sessionText"),
  networkText: document.getElementById("networkText"),
  connectionStatusPanel: document.getElementById("connectionStatusPanel"),
  connectionStatusText: document.getElementById("connectionStatusText"),
  connectionRefreshBtn: document.getElementById("connectionRefreshBtn"),
  sessionExpiryText: document.getElementById("sessionExpiryText"),
  volumeInput: document.getElementById("volumeInput"),
  autoResetSecInput: document.getElementById("autoResetSecInput"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  opsWarnings: document.getElementById("opsWarnings"),
  stickyStack: document.getElementById("stickyStack"),
  storePaymentsMount: document.getElementById("storePaymentsMount"),
  storePaymentsControl: document.getElementById("storePaymentsControl"),
  storePaymentsStatusBadge: document.getElementById("storePaymentsStatusBadge"),
  storePaymentsStatusText: document.getElementById("storePaymentsStatusText"),
  storePaymentsRefreshBtn: document.getElementById("storePaymentsRefreshBtn"),
  storePaymentsToggleBtn: document.getElementById("storePaymentsToggleBtn"),
  amountInput: document.getElementById("amountInput"),
  amountInputError: document.getElementById("amountInputError"),
  paymentChainSelect: document.getElementById("paymentChainSelect"),
  paymentChainHint: document.getElementById("paymentChainHint"),
  amountPresetList: document.getElementById("amountPresetList"),
  presetAmountInput: document.getElementById("presetAmountInput"),
  addPresetBtn: document.getElementById("addPresetBtn"),
  resetPresetBtn: document.getElementById("resetPresetBtn"),
  createInvoiceBtn: document.getElementById("createInvoiceBtn"),
  cancelInvoiceBtn: document.getElementById("cancelInvoiceBtn"),
  expireInvoiceBtn: document.getElementById("expireInvoiceBtn"),
  invoiceDangerActions: document.getElementById("invoiceDangerActions"),
  invoiceStatusPill: document.getElementById("invoiceStatusPill"),
  invoiceIdText: document.getElementById("invoiceIdText"),
  fixedQrUrlLink: document.getElementById("fixedQrUrlLink"),
  paymentUrlLink: document.getElementById("paymentUrlLink"),
  paymentChainText: document.getElementById("paymentChainText"),
  paymentContractText: document.getElementById("paymentContractText"),
  qrCanvas: document.getElementById("qrCanvas"),
  qrAccessibleText: document.getElementById("qrAccessibleText"),
  policyGuideQrCanvas: document.getElementById("policyGuideQrCanvas"),
  policyGuideOriginText: document.getElementById("policyGuideOriginText"),
  policyTermsLink: document.getElementById("policyTermsLink"),
  policyPrivacyLink: document.getElementById("policyPrivacyLink"),
  policyRefundLink: document.getElementById("policyRefundLink"),
  policySecurityLink: document.getElementById("policySecurityLink"),
  invoiceConsentPanel: document.getElementById("invoiceConsentPanel"),
  invoiceConsentBadge: document.getElementById("invoiceConsentBadge"),
  invoiceConsentBody: document.getElementById("invoiceConsentBody"),
  invoiceConsentCheckbox: document.getElementById("invoiceConsentCheckbox"),
  recordConsentBtn: document.getElementById("recordConsentBtn"),
  invoiceConsentStatus: document.getElementById("invoiceConsentStatus"),
  expiresAtText: document.getElementById("expiresAtText"),
  amountText: document.getElementById("amountText"),
  paidText: document.getElementById("paidText"),
  amountComparePanel: document.getElementById("amountComparePanel"),
  amountCompareExpected: document.getElementById("amountCompareExpected"),
  amountComparePaid: document.getElementById("amountComparePaid"),
  amountCompareDelta: document.getElementById("amountCompareDelta"),
  reasonText: document.getElementById("reasonText"),
  fulfillmentDecisionBanner: document.getElementById("fulfillmentDecisionBanner"),
  fulfillmentDecisionBadge: document.getElementById("fulfillmentDecisionBadge"),
  fulfillmentDecisionTitle: document.getElementById("fulfillmentDecisionTitle"),
  fulfillmentDecisionBody: document.getElementById("fulfillmentDecisionBody"),
  providerOperatorStateText: document.getElementById("providerOperatorStateText"),
  providerStatusText: document.getElementById("providerStatusText"),
  refreshBtn: document.getElementById("refreshBtn"),
  reissueInvoiceBtn: document.getElementById("reissueInvoiceBtn"),
  presentTapBtn: document.getElementById("presentTapBtn"),
  resumeQrBtn: document.getElementById("resumeQrBtn"),
  providerControlHint: document.getElementById("providerControlHint"),
  tapModePanel: document.getElementById("tapModePanel"),
  tapModeBadge: document.getElementById("tapModeBadge"),
  tapModeTitle: document.getElementById("tapModeTitle"),
  tapModeBody: document.getElementById("tapModeBody"),
  tapModeAmount: document.getElementById("tapModeAmount"),
  customerDisplayHint: document.getElementById("customerDisplayHint"),
  operatorGuideBadge: document.getElementById("operatorGuideBadge"),
  operatorGuideHeadline: document.getElementById("operatorGuideHeadline"),
  operatorGuideBody: document.getElementById("operatorGuideBody"),
  operatorGuideList: document.getElementById("operatorGuideList"),
  operatorWalletChips: document.getElementById("operatorWalletChips"),
  operatorWalletHelpLink: document.getElementById("operatorWalletHelpLink"),
  operatorStreamStatus: document.getElementById("operatorStreamStatus"),
  operatorReviewId: document.getElementById("operatorReviewId"),
  operatorGuideAction: document.getElementById("operatorGuideAction"),
  diagnosticsCard: document.getElementById("diagnosticsCard"),
  diagnosticsStatusBadge: document.getElementById("diagnosticsStatusBadge"),
  diagnosticsUpdatedText: document.getElementById("diagnosticsUpdatedText"),
  diagnosticsDumpText: document.getElementById("diagnosticsDumpText"),
  refreshOpsSnapshotBtn: document.getElementById("refreshOpsSnapshotBtn"),
  opsSnapshotState: document.getElementById("opsSnapshotState"),
  opsOpenReviewCount: document.getElementById("opsOpenReviewCount"),
  opsDeadLetterCount: document.getElementById("opsDeadLetterCount"),
  opsSettlementStatus: document.getElementById("opsSettlementStatus"),
  opsRecommendedAction: document.getElementById("opsRecommendedAction"),
  opsPriorityReview: document.getElementById("opsPriorityReview"),
  opsRefundCandidateCount: document.getElementById("opsRefundCandidateCount"),
  opsSnapshotChecklist: document.getElementById("opsSnapshotChecklist"),
  opsAddressPoolCount: document.getElementById("opsAddressPoolCount"),
  opsWorkerStatus: document.getElementById("opsWorkerStatus"),
  loadReviewsBtn: document.getElementById("loadReviewsBtn"),
  reviewStatusFilter: document.getElementById("reviewStatusFilter"),
  reviewSummaryChips: document.getElementById("reviewSummaryChips"),
  reviewListState: document.getElementById("reviewListState"),
  reviewsTableBody: document.querySelector("#reviewsTable tbody"),
  reviewDetailBadge: document.getElementById("reviewDetailBadge"),
  reviewDetailSummary: document.getElementById("reviewDetailSummary"),
  reviewDetailId: document.getElementById("reviewDetailId"),
  reviewDetailInvoice: document.getElementById("reviewDetailInvoice"),
  reviewDetailAmount: document.getElementById("reviewDetailAmount"),
  reviewDetailTxHash: document.getElementById("reviewDetailTxHash"),
  reviewDetailAction: document.getElementById("reviewDetailAction"),
  reviewDetailRefundHint: document.getElementById("reviewDetailRefundHint"),
  reviewDetailEvents: document.getElementById("reviewDetailEvents"),
  reviewRelatedInvoices: document.getElementById("reviewRelatedInvoices"),
  reviewIdInput: document.getElementById("reviewIdInput"),
  reviewNextStatus: document.getElementById("reviewNextStatus"),
  reviewDisposition: document.getElementById("reviewDisposition"),
  reviewIncidentId: document.getElementById("reviewIncidentId"),
  reviewNote: document.getElementById("reviewNote"),
  reviewStepUpPin: document.getElementById("reviewStepUpPin"),
  reviewUpdateImpact: document.getElementById("reviewUpdateImpact"),
  updateReviewBtn: document.getElementById("updateReviewBtn"),
  reviewAdjustmentInvoiceId: document.getElementById("reviewAdjustmentInvoiceId"),
  reviewAdjustmentId: document.getElementById("reviewAdjustmentId"),
  reviewAdjustmentType: document.getElementById("reviewAdjustmentType"),
  reviewAdjustmentAmount: document.getElementById("reviewAdjustmentAmount"),
  reviewAdjustmentReason: document.getElementById("reviewAdjustmentReason"),
  reviewAdjustmentEvidenceRef: document.getElementById("reviewAdjustmentEvidenceRef"),
  createAccountingAdjustmentBtn: document.getElementById("createAccountingAdjustmentBtn"),
  loadPendingAdjustmentsBtn: document.getElementById("loadPendingAdjustmentsBtn"),
  handoffAccountingAdjustmentBtn: document.getElementById("handoffAccountingAdjustmentBtn"),
  approveAccountingAdjustmentBtn: document.getElementById("approveAccountingAdjustmentBtn"),
  pendingAdjustmentSelect: document.getElementById("pendingAdjustmentSelect"),
  accountingAdjustmentStatus: document.getElementById("accountingAdjustmentStatus"),
  refundReviewCaseId: document.getElementById("refundReviewCaseId"),
  refundAmount: document.getElementById("refundAmount"),
  refundAddress: document.getElementById("refundAddress"),
  refundAddressPolicyHint: document.getElementById("refundAddressPolicyHint"),
  refundChainId: document.getElementById("refundChainId"),
  requestRefundBtn: document.getElementById("requestRefundBtn"),
  refundIdInput: document.getElementById("refundIdInput"),
  refundTxHashInput: document.getElementById("refundTxHashInput"),
  refundExecutedWalletInput: document.getElementById("refundExecutedWalletInput"),
  refundEvidenceNotePathInput: document.getElementById("refundEvidenceNotePathInput"),
  refundCustomerNoteInput: document.getElementById("refundCustomerNoteInput"),
  approveRefundBtn: document.getElementById("approveRefundBtn"),
  executeRefundBtn: document.getElementById("executeRefundBtn"),
  verifyRefundBtn: document.getElementById("verifyRefundBtn"),
  executeRefundHint: document.getElementById("executeRefundHint"),
  refundDraftHint: document.getElementById("refundDraftHint"),
  refundEligibleHint: document.getElementById("refundEligibleHint"),
  refundStepRequestBadge: document.getElementById("refundStepRequestBadge"),
  refundStepApproveBadge: document.getElementById("refundStepApproveBadge"),
  refundStepEvidenceBadge: document.getElementById("refundStepEvidenceBadge"),
  refundStepRequestPanel: document.getElementById("refundStepRequestPanel"),
  refundStepApprovePanel: document.getElementById("refundStepApprovePanel"),
  refundStepEvidencePanel: document.getElementById("refundStepEvidencePanel"),
  businessDateInput: document.getElementById("businessDateInput"),
  businessMonthInput: document.getElementById("businessMonthInput"),
  loadSettlementPreviewBtn: document.getElementById("loadSettlementPreviewBtn"),
  closeSettlementBtn: document.getElementById("closeSettlementBtn"),
  businessTimezoneText: document.getElementById("businessTimezoneText"),
  settlementConfirmPanel: document.getElementById("settlementConfirmPanel"),
  settlementPreviewBadge: document.getElementById("settlementPreviewBadge"),
  settlementPreviewState: document.getElementById("settlementPreviewState"),
  settlementPreviewBusinessDate: document.getElementById("settlementPreviewBusinessDate"),
  settlementPreviewInvoiceCount: document.getElementById("settlementPreviewInvoiceCount"),
  settlementPreviewPaidCount: document.getElementById("settlementPreviewPaidCount"),
  settlementPreviewReviewCount: document.getElementById("settlementPreviewReviewCount"),
  settlementPreviewBilledTotal: document.getElementById("settlementPreviewBilledTotal"),
  settlementPreviewPaidTotal: document.getElementById("settlementPreviewPaidTotal"),
  settlementPreviewBlockers: document.getElementById("settlementPreviewBlockers"),
  settlementPreviewConfirm: document.getElementById("settlementPreviewConfirm"),
  settlementExportPanel: document.getElementById("settlementExportPanel"),
  settlementExportStatus: document.getElementById("settlementExportStatus"),
  settlementExportId: document.getElementById("settlementExportId"),
  settlementExportRunId: document.getElementById("settlementExportRunId"),
  settlementExportVersion: document.getElementById("settlementExportVersion"),
  settlementExportHash: document.getElementById("settlementExportHash"),
  downloadSettlementCsvBtn: document.getElementById("downloadSettlementCsvBtn"),
  downloadSettlementJsonBtn: document.getElementById("downloadSettlementJsonBtn"),
  reloadSettlementExportBtn: document.getElementById("reloadSettlementExportBtn"),
  settlementExportHint: document.getElementById("settlementExportHint"),
  exportAuditCsvBtn: document.getElementById("exportAuditCsvBtn"),
  exportMonthlyCsvBtn: document.getElementById("exportMonthlyCsvBtn"),
  openAuditLogBtn: document.getElementById("openAuditLogBtn"),
  auditLogPanel: document.getElementById("auditLogPanel"),
  auditLogList: document.getElementById("auditLogList"),
  closeSettlementHint: document.getElementById("closeSettlementHint"),
  adminOperationsMount: document.getElementById("adminOperationsMount"),
  toastHost: document.getElementById("toastHost"),
  permissionNodes: Array.from(document.querySelectorAll("[data-permission], [data-permission-any]")),
};

const DYNAMIC_ELEMENT_SELECTORS = Object.freeze({
  storePaymentsControl: "#storePaymentsControl",
  storePaymentsStatusBadge: "#storePaymentsStatusBadge",
  storePaymentsStatusText: "#storePaymentsStatusText",
  storePaymentsRefreshBtn: "#storePaymentsRefreshBtn",
  storePaymentsToggleBtn: "#storePaymentsToggleBtn",
  refreshOpsSnapshotBtn: "#refreshOpsSnapshotBtn",
  opsSnapshotState: "#opsSnapshotState",
  opsOpenReviewCount: "#opsOpenReviewCount",
  opsDeadLetterCount: "#opsDeadLetterCount",
  opsSettlementStatus: "#opsSettlementStatus",
  opsRecommendedAction: "#opsRecommendedAction",
  opsPriorityReview: "#opsPriorityReview",
  opsRefundCandidateCount: "#opsRefundCandidateCount",
  opsSnapshotChecklist: "#opsSnapshotChecklist",
  opsAddressPoolCount: "#opsAddressPoolCount",
  opsWorkerStatus: "#opsWorkerStatus",
  loadReviewsBtn: "#loadReviewsBtn",
  reviewStatusFilter: "#reviewStatusFilter",
  reviewSummaryChips: "#reviewSummaryChips",
  reviewListState: "#reviewListState",
  reviewsTableBody: "#reviewsTable tbody",
  reviewDetailBadge: "#reviewDetailBadge",
  reviewDetailSummary: "#reviewDetailSummary",
  reviewDetailId: "#reviewDetailId",
  reviewDetailInvoice: "#reviewDetailInvoice",
  reviewDetailAmount: "#reviewDetailAmount",
  reviewDetailTxHash: "#reviewDetailTxHash",
  reviewDetailAction: "#reviewDetailAction",
  reviewDetailRefundHint: "#reviewDetailRefundHint",
  reviewDetailEvents: "#reviewDetailEvents",
  reviewRelatedInvoices: "#reviewRelatedInvoices",
  reviewIdInput: "#reviewIdInput",
  reviewNextStatus: "#reviewNextStatus",
  reviewDisposition: "#reviewDisposition",
  reviewIncidentId: "#reviewIncidentId",
  reviewNote: "#reviewNote",
  reviewStepUpPin: "#reviewStepUpPin",
  reviewUpdateImpact: "#reviewUpdateImpact",
  updateReviewBtn: "#updateReviewBtn",
  reviewAdjustmentInvoiceId: "#reviewAdjustmentInvoiceId",
  reviewAdjustmentId: "#reviewAdjustmentId",
  reviewAdjustmentType: "#reviewAdjustmentType",
  reviewAdjustmentAmount: "#reviewAdjustmentAmount",
  reviewAdjustmentReason: "#reviewAdjustmentReason",
  reviewAdjustmentEvidenceRef: "#reviewAdjustmentEvidenceRef",
  createAccountingAdjustmentBtn: "#createAccountingAdjustmentBtn",
  loadPendingAdjustmentsBtn: "#loadPendingAdjustmentsBtn",
  handoffAccountingAdjustmentBtn: "#handoffAccountingAdjustmentBtn",
  approveAccountingAdjustmentBtn: "#approveAccountingAdjustmentBtn",
  pendingAdjustmentSelect: "#pendingAdjustmentSelect",
  accountingAdjustmentStatus: "#accountingAdjustmentStatus",
  refundReviewCaseId: "#refundReviewCaseId",
  refundAmount: "#refundAmount",
  refundAddress: "#refundAddress",
  refundAddressPolicyHint: "#refundAddressPolicyHint",
  refundChainId: "#refundChainId",
  requestRefundBtn: "#requestRefundBtn",
  refundIdInput: "#refundIdInput",
  refundTxHashInput: "#refundTxHashInput",
  refundExecutedWalletInput: "#refundExecutedWalletInput",
  refundEvidenceNotePathInput: "#refundEvidenceNotePathInput",
  refundCustomerNoteInput: "#refundCustomerNoteInput",
  approveRefundBtn: "#approveRefundBtn",
  executeRefundBtn: "#executeRefundBtn",
  verifyRefundBtn: "#verifyRefundBtn",
  executeRefundHint: "#executeRefundHint",
  refundDraftHint: "#refundDraftHint",
  refundEligibleHint: "#refundEligibleHint",
  refundStepRequestBadge: "#refundStepRequestBadge",
  refundStepApproveBadge: "#refundStepApproveBadge",
  refundStepEvidenceBadge: "#refundStepEvidenceBadge",
  refundStepRequestPanel: "#refundStepRequestPanel",
  refundStepApprovePanel: "#refundStepApprovePanel",
  refundStepEvidencePanel: "#refundStepEvidencePanel",
  businessDateInput: "#businessDateInput",
  businessMonthInput: "#businessMonthInput",
  loadSettlementPreviewBtn: "#loadSettlementPreviewBtn",
  closeSettlementBtn: "#closeSettlementBtn",
  businessTimezoneText: "#businessTimezoneText",
  settlementConfirmPanel: "#settlementConfirmPanel",
  settlementPreviewBadge: "#settlementPreviewBadge",
  settlementPreviewState: "#settlementPreviewState",
  settlementPreviewBusinessDate: "#settlementPreviewBusinessDate",
  settlementPreviewInvoiceCount: "#settlementPreviewInvoiceCount",
  settlementPreviewPaidCount: "#settlementPreviewPaidCount",
  settlementPreviewReviewCount: "#settlementPreviewReviewCount",
  settlementPreviewBilledTotal: "#settlementPreviewBilledTotal",
  settlementPreviewPaidTotal: "#settlementPreviewPaidTotal",
  settlementPreviewBlockers: "#settlementPreviewBlockers",
  settlementPreviewConfirm: "#settlementPreviewConfirm",
  settlementExportPanel: "#settlementExportPanel",
  settlementExportStatus: "#settlementExportStatus",
  settlementExportId: "#settlementExportId",
  settlementExportRunId: "#settlementExportRunId",
  settlementExportVersion: "#settlementExportVersion",
  settlementExportHash: "#settlementExportHash",
  downloadSettlementCsvBtn: "#downloadSettlementCsvBtn",
  downloadSettlementJsonBtn: "#downloadSettlementJsonBtn",
  reloadSettlementExportBtn: "#reloadSettlementExportBtn",
  settlementExportHint: "#settlementExportHint",
  exportAuditCsvBtn: "#exportAuditCsvBtn",
  exportMonthlyCsvBtn: "#exportMonthlyCsvBtn",
  openAuditLogBtn: "#openAuditLogBtn",
  auditLogPanel: "#auditLogPanel",
  auditLogList: "#auditLogList",
  closeSettlementHint: "#closeSettlementHint",
});

function refreshDynamicElementRefs() {
  for (const [key, selector] of Object.entries(DYNAMIC_ELEMENT_SELECTORS)) {
    el[key] = document.querySelector(selector);
  }
  el.permissionNodes = Array.from(document.querySelectorAll("[data-permission], [data-permission-any]"));
}

let screenWakeLock = null;

async function releaseScreenWakeLock() {
  if (!screenWakeLock) return;
  const lock = screenWakeLock;
  screenWakeLock = null;
  try {
    await lock.release();
  } catch (_error) {
    // Wake Lock is best-effort; rendering and payment state remain authoritative.
  }
}

async function requestScreenWakeLock() {
  if (!navigator.wakeLock || document.visibilityState !== "visible") return;
  if (screenWakeLock && !screenWakeLock.released) return;
  try {
    screenWakeLock = await navigator.wakeLock.request("screen");
    screenWakeLock.addEventListener("release", () => {
      screenWakeLock = null;
    }, { once: true });
  } catch (_error) {
    screenWakeLock = null;
  }
}

function safeTimeZone(value) {
  const candidate = String(value || "").trim() || "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("ja-JP", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_error) {
    return "Asia/Tokyo";
  }
}

function nowIsoDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimeZone(state.storeTimezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function idempotencyKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function getStableOperationKey(store, kind, signature) {
  const operationSignature = `${kind}:${String(signature || "")}`;
  if (!store.has(operationSignature)) store.set(operationSignature, idempotencyKey(kind));
  return store.get(operationSignature);
}

function buildAccountingAdjustmentSignature(values = {}) {
  return JSON.stringify({
    invoice_id: String(values.invoiceId ?? el.reviewAdjustmentInvoiceId?.value ?? "").trim(),
    review_case_id: String(values.reviewCaseId ?? el.reviewIdInput?.value ?? "").trim(),
    adjustment_type: String(values.adjustmentType ?? el.reviewAdjustmentType?.value ?? "").trim(),
    amount_jpyc_base: String(values.amount ?? el.reviewAdjustmentAmount?.value ?? "").trim().replace(/^0+(?=\d)/, ""),
    reason: String(values.reason ?? el.reviewAdjustmentReason?.value ?? "").trim(),
    evidence_ref: String(values.evidenceRef ?? el.reviewAdjustmentEvidenceRef?.value ?? "").trim(),
  });
}

function beginAccountingAdjustmentOperation(signature) {
  const operationSignature = String(signature || "");
  if (!operationSignature || state.accountingAdjustmentInFlight.has(operationSignature)) return null;
  let operation = state.accountingAdjustmentOperations.get(operationSignature);
  if (!operation) {
    operation = {
      signature: operationSignature,
      idempotencyKey: idempotencyKey("accounting-adjustment-create"),
      completed: false,
      result: null,
    };
    state.accountingAdjustmentOperations.set(operationSignature, operation);
  }
  state.accountingAdjustmentInFlight.add(operationSignature);
  return operation;
}

function endAccountingAdjustmentOperation(operation) {
  if (!operation?.signature) return;
  state.accountingAdjustmentInFlight.delete(operation.signature);
}

function invalidateResourceRequests() {
  state.invoiceRequestSequence += 1;
  state.latestInvoiceRequestId = "";
  state.reviewListSequence += 1;
  state.reviewListFilter = "";
  state.reviewDetailSequence += 1;
  state.reviewDetailRequestId = "";
  state.opsSnapshotSequence += 1;
  state.opsSnapshotBusinessDate = "";
  state.refundReadSequence += 1;
  state.refundReadRequestId = "";
}

function hasPermission(permission) {
  return state.permissionsKnown && state.effectivePermissions.has(permission);
}

function hasAnyPermission(permissions) {
  return permissions.some((permission) => hasPermission(permission));
}

function mountStorePaymentsControl() {
  const mount = el.storePaymentsMount;
  const shouldMount = Boolean(state.token && state.permissionsKnown && hasPermission("payments.control"));
  if (!mount) return;
  if (!shouldMount) {
    mount.replaceChildren();
    mount.dataset.eventsBound = "false";
    refreshDynamicElementRefs();
    return;
  }
  if (!mount.querySelector("#storePaymentsControl") && STORE_PAYMENTS_CONTROL_MARKUP) {
    mount.insertAdjacentHTML("beforeend", STORE_PAYMENTS_CONTROL_MARKUP);
    refreshDynamicElementRefs();
    bindStorePaymentsEvents();
  }
}

function mountAdminOperations() {
  const mount = el.adminOperationsMount;
  const shouldMount = Boolean(state.token && state.permissionsKnown && hasAnyPermission(ADMIN_UI_PERMISSIONS));
  if (!mount) return;
  if (!shouldMount) {
    mount.replaceChildren();
    mount.dataset.eventsBound = "false";
    refreshDynamicElementRefs();
    return;
  }
  if (!mount.querySelector("[data-admin-only]") && ADMIN_OPERATIONS_MARKUP) {
    mount.insertAdjacentHTML("beforeend", ADMIN_OPERATIONS_MARKUP);
    refreshDynamicElementRefs();
    bindAdminEvents();
  }
}

function requireUiPermission(permission, actionLabel) {
  if (!state.token) {
    showToast("先にログインしてください", true);
    return false;
  }
  if (!hasPermission(permission)) {
    showToast(`${actionLabel}の実効権限がありません`, true);
    return false;
  }
  return true;
}

function setNetworkStatus(message) {
  el.networkText.textContent = message;
  renderConnectionStatus();
}

function nowIso() {
  return new Date().toISOString();
}

function formatDateTime(value) {
  if (!value) return "-";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleString("ja-JP", { timeZone: safeTimeZone(state.storeTimezone), hour12: false });
}

function formatJpy(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  return `¥${amount.toLocaleString("ja-JP")}`;
}

function formatJpyc(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  return `${amount.toLocaleString("ja-JP")} JPYC`;
}

function formatJpycAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  return amount.toLocaleString("ja-JP");
}

function renderConnectionStatus() {
  if (!el.connectionStatusPanel || !el.connectionStatusText) return;
  const sse = state.sseStatus;
  const polling = state.fallbackPollingStatus;
  let kind = "idle";
  let text = "リアルタイム更新: 未接続";
  if (sse === "open") {
    kind = "ok";
    text = "リアルタイム更新: 接続中";
  } else if (sse === "connecting" || sse === "reconnecting" || polling === "active") {
    kind = "warn";
    text = polling === "active" ? "リアルタイム更新: 再接続中（自動更新中）" : "リアルタイム更新: 再接続中";
  } else if (state.token && state.invoiceId) {
    kind = "danger";
    text = "リアルタイム更新: 停止";
  }
  el.connectionStatusPanel.className = `connection-status status-${kind}`;
  el.connectionStatusText.textContent = text;
}

function formatTtl(expiresAt) {
  if (!expiresAt) return "-";
  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) return "invalid";
  const remainSec = Math.floor((expiryMs - Date.now()) / 1000);
  if (remainSec <= 0) return `${remainSec}s (expired)`;
  const mins = Math.floor(remainSec / 60);
  const secs = remainSec % 60;
  return `${remainSec}s (${mins}m ${String(secs).padStart(2, "0")}s)`;
}

function stringifyJson(value) {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch (_error) {
    return String(value ?? "-");
  }
}

function setDiagnosticsBadge(label) {
  el.diagnosticsStatusBadge.textContent = label;
}

function renderChipGroup(host, values, fallback = "未設定") {
  if (!host) return;
  host.innerHTML = "";
  const items = Array.isArray(values) && values.length > 0 ? values : [fallback];
  for (const value of items) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = String(value || fallback);
    host.appendChild(chip);
  }
}

function normalizeWalletCapabilityLabels(values, { manualOnly = false } = {}) {
  const labels = (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => {
      const broadTested = value.match(WALLET_BROAD_TESTED_PREFIX);
      if (broadTested) {
        return `未検証（検証OS・バージョン不明）: ${broadTested[1]}`;
      }
      return WALLET_SCOPED_CAPABILITY_PREFIX.test(value) ? value : `未検証: ${value}`;
    });
  if (manualOnly && !labels.some((value) => value.startsWith("手動送金のみ:"))) {
    labels.push("手動送金のみ: 支払い情報コピー");
  }
  return labels;
}

function normalizePaymentsDisableState(value) {
  if (!value || typeof value !== "object") return null;
  const keys = ["env_forced", "global_disabled", "store_disabled", "terminal_disabled"];
  if (keys.some((key) => typeof value[key] !== "boolean")) return null;
  const normalized = Object.fromEntries(keys.map((key) => [key, value[key] === true]));
  return {
    ...normalized,
    disabled: Object.values(normalized).some(Boolean),
  };
}

function paymentIssuanceAllowed() {
  return state.paymentsReadState === "ready"
    && state.paymentsDisableState?.disabled === false;
}

function renderStorePaymentsControl() {
  if (!el.storePaymentsControl || !el.storePaymentsToggleBtn) return;
  const canControl = hasPermission("payments.control");
  const payments = state.paymentsReadState === "ready" ? state.paymentsDisableState : null;
  const storeDisabled = payments?.store_disabled === true;
  let panelState = "unknown";
  let badge = "状態未確認";
  let badgeClass = "s-red";
  let detail = "停止状態を確認できません。安全のため新規請求は作成せず、店舗停止のみ実行できます。";

  if (state.paymentsReadState === "loading") {
    badge = "状態確認中";
    badgeClass = "s-yellow";
    detail = "店舗・端末・全体の停止状態を確認しています。確認中でも店舗停止は実行できます。";
  } else if (payments?.env_forced) {
    panelState = "stopped";
    badge = "環境強制停止中";
    detail = `環境設定による全体停止中です。店舗UIでは解除できません。${storeDisabled ? " 店舗停止も有効です。" : ""}`;
  } else if (payments?.global_disabled) {
    panelState = "stopped";
    badge = "全体停止中";
    detail = `プラットフォーム全体の停止中です。店舗UIでは解除できません。${storeDisabled ? " 店舗停止も有効です。" : ""}`;
  } else if (storeDisabled) {
    panelState = "stopped";
    badge = "店舗停止中";
    detail = "現在の店舗で新規決済を停止しています。既存の請求・支払い証跡は削除されません。";
  } else if (payments?.terminal_disabled) {
    panelState = "stopped";
    badge = "この端末は停止中";
    detail = "この端末だけが停止中です。店舗全体の停止とは別の操作です。";
  } else if (payments) {
    panelState = "active";
    badge = "店舗受付中";
    badgeClass = "s-green";
    detail = "店舗・端末・全体の停止は有効ではありません。";
  }

  el.storePaymentsControl.dataset.state = panelState;
  el.storePaymentsStatusBadge.textContent = badge;
  el.storePaymentsStatusBadge.className = `status-pill ${badgeClass}`;
  el.storePaymentsStatusText.textContent = detail;
  el.storePaymentsRefreshBtn.disabled = !canControl || state.storePaymentsControlInFlight;
  el.storePaymentsToggleBtn.textContent = storeDisabled
    ? "店舗停止だけを解除"
    : "店舗の新規決済を停止";
  el.storePaymentsToggleBtn.className = `btn ${storeDisabled ? "btn-secondary" : "btn-danger"}`;
  el.storePaymentsToggleBtn.disabled = !canControl || state.storePaymentsControlInFlight;
  el.storePaymentsToggleBtn.classList.toggle("loading", state.storePaymentsControlInFlight);
}

function setPaymentsDisableState(value, readState = "ready") {
  const normalized = normalizePaymentsDisableState(value);
  state.paymentsDisableState = normalized;
  state.paymentsReadState = normalized && readState === "ready" ? "ready" : readState;
  renderStorePaymentsControl();
  syncInvoiceOperationControls();
}

async function loadStorePaymentsState({ silent = false } = {}) {
  if (!state.token || !state.storeId) return;
  state.paymentsDisableState = null;
  state.paymentsReadState = "loading";
  renderStorePaymentsControl();
  syncInvoiceOperationControls();
  try {
    const data = await requestJson(`/api/v1/stores/${encodeURIComponent(state.storeId)}/settings`);
    const normalized = normalizePaymentsDisableState(data.payments);
    if (!normalized) throw new Error("店舗決済の停止状態が不完全です");
    state.storePaymentsOperation = null;
    setPaymentsDisableState(normalized);
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    setPaymentsDisableState(null, "error");
    if (!silent) showToast("店舗決済の停止状態を確認できません。新規請求は停止しました", true);
  }
}

async function handleStorePaymentsToggle() {
  if (!requireUiPermission("payments.control", "店舗決済コントロール")) return;
  if (!state.storeId || state.storePaymentsControlInFlight) return;
  const storeDisabled = state.paymentsReadState === "ready"
    && state.paymentsDisableState?.store_disabled === true;
  const action = storeDisabled ? "enable" : "disable";
  if (action === "enable" && !window.confirm(
    "現在の店舗の停止だけを解除します。全体停止・環境強制停止・端末停止は解除されません。続けますか？"
  )) return;

  const signature = `${action}:${state.storeId}`;
  if (state.storePaymentsOperation?.signature !== signature) {
    state.storePaymentsOperation = {
      signature,
      idempotencyKey: idempotencyKey(`store-payments-${action}`),
    };
  }
  const operation = state.storePaymentsOperation;
  state.storePaymentsControlInFlight = true;
  state.paymentsDisableState = null;
  state.paymentsReadState = "loading";
  renderStorePaymentsControl();
  syncInvoiceOperationControls();
  try {
    const data = await requestJson(
      `/api/v1/admin/stores/${encodeURIComponent(state.storeId)}/payments/${action}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": operation.idempotencyKey,
        },
        body: JSON.stringify({
          reason: action === "disable" ? "terminal_store_emergency_stop" : "terminal_store_stop_cleared",
        }),
      }
    );
    state.storePaymentsOperation = null;
    setPaymentsDisableState(data);
    showToast(action === "disable"
      ? "店舗の新規決済を停止し、監査ログに記録しました"
      : "店舗停止だけを解除し、監査ログに記録しました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    setPaymentsDisableState(null, "error");
    showToast("操作結果を確認できません。同じ操作を再試行するか、状態を再確認してください", true);
  } finally {
    state.storePaymentsControlInFlight = false;
    renderStorePaymentsControl();
    syncInvoiceOperationControls();
  }
}

function wouldAllowFulfillment(invoice) {
  return getAuthoritativeFulfillmentDecision(invoice).decision === "allow";
}

function hasFreshFulfillmentObservation() {
  const lastRefreshMs = Date.parse(state.lastInvoiceRefreshAt || "");
  return state.fulfillmentObservationValid === true
    && Number.isFinite(lastRefreshMs)
    && Date.now() - lastRefreshMs <= FULFILLMENT_FRESHNESS_MS
    && (state.sseStatus === "open" || state.fallbackPollingStatus === "active");
}

function isFulfillmentObservationUnavailable(invoice = state.currentInvoice) {
  return !hasIntegrityHold(invoice)
    && wouldAllowFulfillment(invoice)
    && !hasFreshFulfillmentObservation();
}

function resolveFulfillmentDecisionModel(invoice) {
  if (hasIntegrityHold(invoice)) {
    const policy = getOperatorActionPolicy("integrity_hold");
    return {
      decision: "hold",
      badge: "記録整合性を確認中・渡さない",
      badgeClass: "s-red",
      title: policy.handoff,
      body: `${policy.next} ${policy.manager}`,
    };
  }
  const status = effectiveOperatorStatus(invoice);
  const authoritativeDecision = getAuthoritativeFulfillmentDecision(invoice);
  if (authoritativeDecision.decision !== "allow") {
    const policy = getOperatorActionPolicy(status);
    return {
      decision: "hold",
      badge: "サーバー判定が引渡しを保留中",
      badgeClass: "s-red",
      title: "サーバーの引渡し許可が確認できるまで渡さない",
      body: `${authoritativeDecision.reason_codes?.join(", ") || "FULFILLMENT_DECISION_UNAVAILABLE"}。${policy.manager}`,
    };
  }
  if (isFulfillmentObservationUnavailable(invoice)) {
    return {
      decision: "hold",
      badge: "状態更新を確認できないため渡さない",
      badgeClass: "s-red",
      title: "最新の支払い状態を確認できるまで渡さない",
      body: "リアルタイム更新または最新取得が止まっています。再取得が成功するまで商品を渡さず、必要なら店長へ連絡してください。",
    };
  }
  return {
    decision: "allow",
    badge: "商品を渡してOK",
    badgeClass: "s-green",
    title: "店頭端末の引渡し許可を確認しました",
    body: "商品を渡せます。JPYCの支払い確認と日次締めは別の記録として追跡されます。",
  };
}

function renderFulfillmentDecisionBanner(invoice = state.currentInvoice) {
  if (!el.fulfillmentDecisionBanner) return;
  const model = resolveFulfillmentDecisionModel(invoice);
  el.fulfillmentDecisionBanner.dataset.decision = model.decision;
  el.fulfillmentDecisionBadge.textContent = model.badge;
  el.fulfillmentDecisionBadge.className = `status-pill ${model.badgeClass}`;
  el.fulfillmentDecisionTitle.textContent = model.title;
  el.fulfillmentDecisionBody.textContent = model.body;
}

function stopFulfillmentFreshnessTimer() {
  if (!state.fulfillmentFreshnessTimer) return;
  clearTimeout(state.fulfillmentFreshnessTimer);
  state.fulfillmentFreshnessTimer = null;
}

function failClosedFulfillmentObservation() {
  state.fulfillmentObservationValid = false;
  stopFulfillmentFreshnessTimer();
  renderFulfillmentSafetySurfaces();
}

function refreshFulfillmentObservationAfterResume() {
  if (!state.token || !state.invoiceId || document.visibilityState === "hidden") return;
  // iPad/Safari may suspend timers and EventSource while backgrounded. Keep
  // the last green decision hidden until a fresh server response is accepted.
  failClosedFulfillmentObservation();
  void loadInvoice(state.invoiceId, { silent: true }).then((result) => {
    if (result?.status === "ok" && state.sseStatus !== "open") {
      void connectTerminalStream();
    }
  });
}

function renderFulfillmentSafetySurfaces() {
  setInvoiceStatusPill(state.invoiceStatus);
  renderProviderControls(state.currentInvoice);
  renderCustomerFacingQr();
  renderInvoiceConsent();
  renderOperatorGuide();
}

function scheduleFulfillmentFreshnessHold() {
  stopFulfillmentFreshnessTimer();
  if (!wouldAllowFulfillment(state.currentInvoice)) return;
  const lastRefreshMs = Date.parse(state.lastInvoiceRefreshAt || "");
  if (!Number.isFinite(lastRefreshMs)) {
    failClosedFulfillmentObservation();
    return;
  }
  const delayMs = Math.max(lastRefreshMs + FULFILLMENT_FRESHNESS_MS - Date.now() + 1, 1);
  state.fulfillmentFreshnessTimer = setTimeout(() => {
    state.fulfillmentFreshnessTimer = null;
    state.fulfillmentObservationValid = false;
    renderFulfillmentSafetySurfaces();
  }, delayMs);
}

function normalizeAmountPresetList(values) {
  const normalized = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount <= 0 || seen.has(amount)) continue;
    normalized.push(amount);
    seen.add(amount);
    if (normalized.length >= MAX_AMOUNT_PRESET_COUNT) break;
  }
  return normalized;
}

function warnSettingsStorageFallback() {
  if (settingsStorageWarningShown) return;
  settingsStorageWarningShown = true;
  window.setTimeout(() => showToast("このブラウザでは端末設定を永続保存できません。この画面を閉じるまでの一時設定として使用します", true), 0);
}

function readSettingsStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (_error) {
    warnSettingsStorageFallback();
    return volatileSettingsStorage.get(key) || null;
  }
}

function writeSettingsStorage(key, value) {
  volatileSettingsStorage.set(key, value);
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (_error) {
    warnSettingsStorageFallback();
    return false;
  }
}

function defaultTerminalSettings() {
  return {
    volume: DEFAULT_TERMINAL_SETTINGS.volume,
    auto_reset_sec: DEFAULT_TERMINAL_SETTINGS.auto_reset_sec,
    amount_presets: [...DEFAULT_AMOUNT_PRESETS],
  };
}

function settingsScopeHash(value) {
  let hash = 2166136261;
  for (const character of String(value || "").normalize("NFKC")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function currentSettingsStorageKey() {
  const storeId = String(state.storeId || "").trim();
  const terminalId = String(state.terminalId || "").trim();
  const operatorIdentity = String(state.staffCode || state.staffName || "").trim();
  if (!state.token || !storeId || !terminalId || !operatorIdentity) return "";
  return `${SETTINGS_NAMESPACE}:${encodeURIComponent(storeId)}:${encodeURIComponent(terminalId)}:${settingsScopeHash(operatorIdentity)}`;
}

function normalizeTerminalSettings(source, fallback = defaultTerminalSettings()) {
  const settings = source?.schema_version === SETTINGS_SCHEMA_VERSION ? source.settings : source;
  return {
    volume: Number.isFinite(settings?.volume) ? Number(settings.volume) : fallback.volume,
    auto_reset_sec: Number.isFinite(settings?.auto_reset_sec)
      ? Number(settings.auto_reset_sec)
      : fallback.auto_reset_sec,
    amount_presets: Object.prototype.hasOwnProperty.call(settings || {}, "amount_presets")
      ? normalizeAmountPresetList(settings.amount_presets)
      : fallback.amount_presets,
  };
}

function serializeTerminalSettings(settings) {
  return JSON.stringify({
    schema_version: SETTINGS_SCHEMA_VERSION,
    settings,
  });
}

function readTerminalSettings() {
  // Pre-v2 settings lived under one global storage key shared by every
  // operator on this browser. They cannot be attributed to a specific
  // operator identity, so they are intentionally never migrated or reused:
  // operators without v2 scoped settings start from defaults instead of
  // inheriting another operator's values.
  const fallback = defaultTerminalSettings();
  const storageKey = currentSettingsStorageKey();
  if (!storageKey) return fallback;
  const raw = readSettingsStorage(storageKey);
  if (!raw) return fallback;
  try {
    return normalizeTerminalSettings(JSON.parse(raw), fallback);
  } catch (_error) {
    return fallback;
  }
}

function writeTerminalSettings(nextSettings, { showSavedToast = false } = {}) {
  const current = readTerminalSettings();
  const merged = {
    volume: Number.isFinite(nextSettings?.volume) ? Number(nextSettings.volume) : current.volume,
    auto_reset_sec: Number.isFinite(nextSettings?.auto_reset_sec)
      ? Number(nextSettings.auto_reset_sec)
      : current.auto_reset_sec,
    amount_presets: Object.prototype.hasOwnProperty.call(nextSettings || {}, "amount_presets")
      ? normalizeAmountPresetList(nextSettings.amount_presets)
      : current.amount_presets,
  };
  const storageKey = currentSettingsStorageKey();
  const persisted = Boolean(storageKey) && writeSettingsStorage(storageKey, serializeTerminalSettings(merged));
  if (showSavedToast) {
    showToast(persisted ? "端末設定を保存しました" : "端末設定をこの画面内だけに反映しました", !persisted);
  }
  return merged;
}

function renderAmountPresetButtons() {
  const settings = readTerminalSettings();
  const presets = settings.amount_presets;
  el.amountPresetList.innerHTML = "";
  if (presets.length === 0) {
    const empty = document.createElement("span");
    empty.className = "chip";
    empty.textContent = "プリセット未登録";
    el.amountPresetList.appendChild(empty);
    return;
  }
  for (const amount of presets) {
    const chip = document.createElement("div");
    chip.className = "preset-chip";

    const useButton = document.createElement("button");
    useButton.type = "button";
    useButton.className = "btn btn-secondary btn-use";
    useButton.dataset.presetAction = "use";
    useButton.dataset.amountPreset = String(amount);
    useButton.textContent = formatJpy(amount);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "btn btn-ghost btn-remove";
    removeButton.dataset.presetAction = "remove";
    removeButton.dataset.amountPreset = String(amount);
    removeButton.setAttribute("aria-label", `${formatJpy(amount)} のプリセットを削除`);
    removeButton.textContent = "×";

    chip.append(useButton, removeButton);
    el.amountPresetList.appendChild(chip);
  }
}

function setHelperLink(linkEl, href, label) {
  if (typeof href === "string" && href.trim()) {
    try {
      const destination = new URL(href.trim(), window.location.origin);
      const allowed = !destination.username
        && !destination.password
        && (destination.protocol === "https:" || destination.origin === window.location.origin);
      if (allowed) {
        linkEl.href = destination.href;
        linkEl.textContent = label;
        linkEl.classList.remove("hidden");
        return;
      }
    } catch (_error) {
      // Invalid or unsafe helper URLs remain hidden.
    }
  }
  linkEl.classList.add("hidden");
  linkEl.removeAttribute("href");
}

function setChecklist(host, items, fallback = "重大な未処理はありません。") {
  host.innerHTML = "";
  const rows = Array.isArray(items) && items.length > 0 ? items : [fallback];
  for (const item of rows) {
    const li = document.createElement("li");
    li.textContent = item;
    host.appendChild(li);
  }
}

function isLikelyEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

function shortId(value, head = 8, tail = 4) {
  const text = String(value || "");
  if (!text) return "-";
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function reviewStatusSortRank(status) {
  const key = String(status || "");
  return Object.prototype.hasOwnProperty.call(REVIEW_STATUS_SORT_ORDER, key) ? REVIEW_STATUS_SORT_ORDER[key] : 99;
}

function reviewReasonPriorityRank(reasonType) {
  const key = normalizeReviewReason(reasonType);
  return Object.prototype.hasOwnProperty.call(REVIEW_REASON_PRIORITY_ORDER, key) ? REVIEW_REASON_PRIORITY_ORDER[key] : 50;
}

function reviewAgeMinutes(review) {
  const createdMs = Date.parse(String(review?.created_at || ""));
  if (!Number.isFinite(createdMs)) return 0;
  return Math.max(Math.floor((Date.now() - createdMs) / 60_000), 0);
}

function isRefundCandidateReason(reasonType) {
  return REFUND_CANDIDATE_REASONS.has(normalizeReviewReason(reasonType));
}

function reviewPriorityMeta(review) {
  const status = String(review?.status || "");
  if (!["open", "in_progress"].includes(status)) {
    return { label: "完了", className: "s-gray", sortRank: 3 };
  }
  const reasonRank = reviewReasonPriorityRank(review?.reason_type);
  if (reasonRank === 0) {
    return { label: "最優先", className: "s-red", sortRank: 0 };
  }
  if (reasonRank === 1 || status === "in_progress") {
    return { label: "優先", className: "s-yellow", sortRank: 1 };
  }
  return { label: "通常", className: "s-blue", sortRank: 2 };
}

function compareReviewsByPriority(a, b) {
  const byStatus = reviewStatusSortRank(a?.status) - reviewStatusSortRank(b?.status);
  if (byStatus !== 0) return byStatus;
  const byPriority = reviewPriorityMeta(a).sortRank - reviewPriorityMeta(b).sortRank;
  if (byPriority !== 0) return byPriority;
  const byReason = reviewReasonPriorityRank(a?.reason_type) - reviewReasonPriorityRank(b?.reason_type);
  if (byReason !== 0) return byReason;
  const byAge = reviewAgeMinutes(b) - reviewAgeMinutes(a);
  if (byAge !== 0) return byAge;
  const aCreated = Date.parse(String(a?.created_at || ""));
  const bCreated = Date.parse(String(b?.created_at || ""));
  if (Number.isFinite(aCreated) && Number.isFinite(bCreated) && aCreated !== bCreated) {
    return aCreated - bCreated;
  }
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function renderOpsWarningsList(warnings) {
  el.opsWarnings.innerHTML = "";
  if (!Array.isArray(warnings) || warnings.length === 0) {
    const li = document.createElement("li");
    li.textContent = "重大な警告はありません。";
    el.opsWarnings.appendChild(li);
    return;
  }
  for (const warning of warnings) {
    const li = document.createElement("li");
    li.textContent = warning;
    el.opsWarnings.appendChild(li);
  }
}

function detectWorkerStaleSec(stateRows) {
  const workerRow = (Array.isArray(stateRows) ? stateRows : []).find((r) => r.key === "worker:last_cycle_at");
  if (!workerRow?.value) return null;
  const lastMs = Date.parse(workerRow.value);
  if (!Number.isFinite(lastMs)) return null;
  return Math.floor((Date.now() - lastMs) / 1000);
}

function buildMonitorWarnings(monitor) {
  const warnings = [];
  const pendingDead = Number(monitor?.pending_dead_letter_count || 0);
  const abandonedDead = Number(monitor?.abandoned_dead_letter_count || 0);
  const unmatched = Number(monitor?.unmatched_event_count || 0);
  const failover = Number(monitor?.failover_count || 0);
  if (pendingDead > 0) warnings.push(`状態更新の再処理待ちが ${pendingDead} 件あります。店長またはサポートに確認を依頼してください。`);
  if (abandonedDead > 0) warnings.push(`手動確認が必要な状態更新が ${abandonedDead} 件あります。新しいJPYC決済を受け付ける前に店長へ連絡してください。`);
  if (unmatched > 0) warnings.push(`請求と照合できていない入金候補が ${unmatched} 件あります。管理者が確認するまで商品引渡しを保留してください。`);
  if (failover > 0) warnings.push(`状態更新の再試行が ${failover} 回発生しています。店長またはサポートに状況確認を依頼してください。`);

  const stateRows = Array.isArray(monitor?.state) ? monitor.state : [];
  if (stateRows.length === 0) {
    warnings.push("状態更新が停止しています。新しいJPYC決済を受け付けないでください。店長またはサポートに連絡してください。");
  } else {
    const staleSec = detectWorkerStaleSec(stateRows);
    if (staleSec !== null && staleSec > WORKER_STALE_WARN_SEC) {
      warnings.push("状態更新が停止しています。新しいJPYC決済を受け付けないでください。店長またはサポートに連絡してください。");
    }
  }

  const poolCount = Number(monitor?.address_pool_available_count ?? -1);
  if (poolCount >= 0 && poolCount <= ADDRESS_POOL_WARN_THRESHOLD) {
    warnings.push("受取アドレス残数が少なくなっています。管理者に補充を依頼してください。");
  }

  return warnings;
}

function renderOperatorGuide() {
  const invoice = state.currentInvoice;
  const invoiceStatus = effectiveOperatorStatus(invoice);
  const status = isFulfillmentObservationUnavailable(invoice)
    ? "observation_unavailable"
    : invoiceStatus;
  const providerSummary = invoice?.provider_summary || null;
  const walletAdapter = invoice?.wallet_adapter || {};
  const reviewCaseId = invoice?.review_case_id || null;
  const supportedWallets =
    Array.isArray(invoice?.supported_wallets) && invoice.supported_wallets.length > 0
      ? invoice.supported_wallets
      : state.supportedWallets;
  const streamStatus =
    state.sseStatus === "open"
      ? "自動更新中"
      : state.fallbackPollingStatus === "active"
        ? "低速更新に切替中"
        : state.token
          ? "待機中"
          : "未ログイン";

  const providerGuideMap = {
    waiting_customer: {
      badge: "タッチ案内",
      headline: "カード・スマホをかざしてもらう段階です",
      body: "端末入口QRからのウォレット案内は一時停止中です。店頭ではタッチ案内だけを続け、別の支払い導線を同時に案内しません。",
      action: "タッチ待ち",
      items: [
        "お客様にはカード・スマホをかざす案内だけを出します。",
        "端末入口QRからのウォレット導線は一時停止しています。",
        "別の支払い方法へ切り替える場合は、店員が明示的に QR 案内へ戻します。",
      ],
    },
    authorizing: {
      badge: "タッチ案内",
      headline: "店頭端末の受付結果を待っています",
      body: "店頭端末側の証跡を保持し、JPYC請求の支払い確認とは分けて扱います。",
      action: "認証待ち",
      items: [
        "別の支払い方法を同時に開かず、この会計の結果を待ちます。",
        "店頭端末の受付結果だけでJPYCの支払い確認済み扱いにしません。",
        "商品引渡しの可否はこのカードの表示で判断します。",
      ],
    },
    fulfillment_ok: {
      badge: "Tap OK",
      headline: "商品渡しの判断材料は揃っています",
      body: "商品渡しOKの表示が出ています。会計上の記録と日次締めは別途システムに残ります。",
      action: "商品渡しOK",
      items: [
        "店頭では商品渡し判断を行えます。",
        "会計上の確定処理は日次締めで追跡します。",
        "例外が出た場合だけ確認待ちに回します。",
      ],
    },
    retry_required: {
      badge: "Tap Retry",
      headline: "このままでは完了していません",
      body: "店頭端末側の失敗後は、店員が次の案内を明示的に選びます。",
      action: "再試行判断",
      items: [
        "tap を再提示するか、QR 案内へ戻すかを店員が選びます。",
        "曖昧に二重導線へしないことが重要です。",
        "返金証跡、確認待ち、無効化を混同しません。",
      ],
    },
    needs_review: {
      badge: "Tap Review",
      headline: "店頭判断を止めて管理者確認へ回してください",
      body: "金額差や照合できない支払いは、その場の便利さより証跡を優先します。",
      action: "review対応",
      items: [
        "商品は渡さず、確認待ち一覧で原因を確認します。",
        "支払い証跡と請求のつながりを崩さずに例外処理します。",
        "必要なら返金記録を別途作成します。",
      ],
    },
  };

  const guideMap = {
    idle: {
      badge: "Merchant Ops",
      headline: "端末入口QRを置いたまま、新しい会計だけを作成できます",
      body: "小規模店舗やイベントでは、端末入口QRを入口にして会計の正本を請求記録に残すことで、現場の迷いと監査負荷を同時に減らせます。",
      action: "QR発行",
      items: [
        "お客様に見せる主QRは端末固定です。請求ごとに QR を貼り替える必要はありません。",
        "よく使う金額プリセットで素早く会計を始めます。",
        "ノンカストディ前提なので、秘密鍵やシードフレーズは扱いません。",
        "完了 / 要確認の分岐は確認待ち一覧で追跡できます。",
      ],
    },
    issued: {
      badge: "支払い待ち",
      headline: "端末入口QRを提示し、送金完了までこの会計を見守ります",
      body: "お客様画面は端末入口QRからその時点の会計に一度だけ紐づくため、会計の正本は請求記録のまま維持されます。",
      action: "QR提示",
      items: [
        "別会計を同じ端末で同時に始めることはできません。",
        "ウォレットが起動しない場合は、お客様画面のコピー導線を案内します。",
        "送金後は自動更新を待ち、二重送信を促さないようにします。",
        "期限切れや重複は確認待ち一覧に送られるため、その場で切り分けできます。",
      ],
    },
    payment_detected: {
      badge: "確認中",
      headline: "入金検知済みです。お客様にはそのままお待ちいただいてください",
      body: "この段階では二重送信を止め、確認完了までレジ側で状態変化を見守るのが最優先です。",
      action: "待機",
      items: [
        "送金は 1 回で十分です。追加送金は案内しません。",
        "SSE または polling fallback で自動更新されます。",
        "長引く場合は manual review に上がっていないか確認します。",
      ],
    },
    confirming: {
      badge: "確認中",
      headline: "オンチェーン確認を待っています",
      body: "送金済みかどうかだけでなく、いまどこまで確認できているかをスタッフ全員で共有することが重要です。",
      action: "待機",
      items: [
        "お客様には画面を閉じずに少し待つよう案内します。",
        "反映が遅い場合でも、重複送金は避けてもらいます。",
        "必要なら確認待ち一覧と取引番号で追跡します。",
      ],
    },
    paid: {
      badge: "完了",
      headline: "支払いを確認しました。次の会計へ進めます",
      body: "Merchant Ops の観点では、完了をすぐ把握して日次締めへつなげられることが重要です。",
      action: "次の会計",
      items: [
        "必要ならレシートや注文処理を続けます。",
        "再発行や再送金の案内は不要です。",
        "監査ログと日次締めにこの支払いが反映されます。",
      ],
    },
    settled: {
      badge: "完了",
      headline: "支払いは確定済みです",
      body: "監査と日次締めまで一貫して扱えるため、実証運用の証跡づくりに向いています。",
      action: "締め処理へ",
      items: [
        "CSV 出力や日次締めの対象として扱えます。",
        "返金が必要な場合のみ review / refund へ進みます。",
        "現場での追加操作は基本不要です。",
      ],
    },
    review_required: {
      badge: "要確認",
      headline: "確認待ち支払いとして管理者レビューへ引き継いでください",
      body: "ここが運用レイヤーの要点です。過不足、重複、期限後着金を決済後に整理できます。",
      action: "レビュー対応",
      items: [
        "下の一覧から対象レビューを選び、詳細を確認します。",
        "必要に応じて返金申請を作成し、外部ウォレット送金の証跡を残します。",
        "お客様には店舗側で確認する旨を短く案内します。",
      ],
    },
    integrity_hold: {
      badge: "記録整合性を確認中",
      headline: "商品を渡さず、追加送金も案内しないでください",
      body: "チェーン記録の整合性を確認しています。保留が解除されるまで、会計判断を進めません。",
      action: "商品引渡し保留",
      items: [
        "商品は渡さず、店長または管理者を呼びます。",
        "お客様には追加で送金しないよう案内します。",
        "画面の保留表示が解除されるまで自動更新を待ちます。",
      ],
    },
    observation_unavailable: {
      badge: "状態再確認中",
      headline: "最新状態を確認できるまで商品を渡さないでください",
      body: "最後に確認した完了表示は再確認中です。自動更新または最新取得が成功するまで引渡しを保留します。",
      action: "商品引渡し保留",
      items: [
        "商品は渡さず、自動更新または最新状態の再取得を待ちます。",
        "お客様には追加送金しないよう案内します。",
        "再取得できない場合は店長または管理者へ引き継ぎます。",
      ],
    },
    expired: {
      badge: "再発行",
      headline: "期限切れです。必要なら新しい QR を再発行してください",
      body: "期限切れ後の着金は確認待ち一覧で分岐できるため、現場では再発行判断に集中できます。",
      action: "QR再発行",
      items: [
        "お客様には古い QR が使えないことを伝えます。",
        "再発行すると新しい請求 ID と URL に切り替わります。",
        "期限後着金があった場合は確認待ち一覧で確認します。",
      ],
    },
    cancelled: {
      badge: "無効",
      headline: "この請求は無効化されています",
      body: "取り消した請求は再利用せず、必要であれば新しい請求を作成します。",
      action: "新規発行",
      items: [
        "旧 QR は使わず、新しい請求を発行します。",
        "誤案内を防ぐため、お客様画面も再読み込みしてもらいます。",
        "支払い証跡がある場合は確認待ち一覧で確認します。",
      ],
    },
  };

  const fallback = guideMap[status] || guideMap.idle;
  const providerFallback = PROVIDER_RAIL_ENABLED
    && !["integrity_hold", "observation_unavailable"].includes(status)
    && providerSummary?.available
    ? providerGuideMap[providerSummary.operator_state?.code]
    : null;
  const resolvedGuide = providerFallback || fallback;
  const actionPolicy = getOperatorActionPolicy(providerFallback ? "review_required" : status);
  el.operatorGuideBadge.textContent = providerFallback ? resolvedGuide.badge : actionPolicy.label;
  el.operatorGuideHeadline.textContent = providerFallback ? resolvedGuide.headline : `${actionPolicy.label}: ${actionPolicy.handoff.replace("商品引渡し: ", "")}`;
  el.operatorGuideBody.textContent = providerFallback
    ? resolvedGuide.body
    : "スタッフは暗号資産の細部ではなく、商品引渡し可否・次の安全な操作・店長確認の要否だけを見て判断します。";
  if (providerFallback) {
    el.operatorGuideBody.textContent = resolvedGuide.body;
  } else if (walletAdapter.reason && ["issued", "payment_detected", "confirming"].includes(status)) {
    el.operatorGuideBody.textContent += " ウォレット自動起動が使えない場合は、支払い情報コピーの案内に切り替えてください。";
  }
  el.operatorGuideAction.textContent = providerFallback ? resolvedGuide.action : actionPolicy.action;
  el.operatorStreamStatus.textContent = streamStatus;
  el.operatorReviewId.textContent = reviewCaseId || "-";
  if (providerFallback) {
    renderChipGroup(el.operatorWalletChips, [
      providerSummary.provider_code || "店頭端末連携",
      providerSummary.payment_session_status || "presented",
    ], "店頭端末連携");
    el.operatorWalletHelpLink.classList.add("hidden");
    el.operatorWalletHelpLink.removeAttribute("href");
  } else {
    const capabilityLabels = normalizeWalletCapabilityLabels(supportedWallets, {
      manualOnly: walletAdapter.available !== true || walletAdapter.status !== "ready",
    });
    renderChipGroup(el.operatorWalletChips, capabilityLabels, "未検証: ウォレット情報なし");
    setHelperLink(el.operatorWalletHelpLink, invoice?.wallet_help_url || "", "お客様向けウォレット案内を開く");
  }

  el.operatorGuideList.innerHTML = "";
  const actionItems = providerFallback
    ? resolvedGuide.items
    : [actionPolicy.handoff, actionPolicy.next, actionPolicy.manager, actionPolicy.script, ...resolvedGuide.items.slice(0, 2)];
  for (const item of actionItems) {
    const li = document.createElement("li");
    li.textContent = item;
    el.operatorGuideList.appendChild(li);
  }
  renderFulfillmentDecisionBanner(invoice);
}

function computeReviewSuggestion(review) {
  const reasonType = normalizeReviewReason(review?.reason_code || review?.reason_type);
  const expected = Number(review?.amount_jpyc);
  const paid = Number(review?.paid_amount_jpyc);
  const isExpectedFinite = Number.isFinite(expected);
  const isPaidFinite = Number.isFinite(paid);
  const priority = reviewPriorityMeta(review);

  if (reasonType === "OVERPAYMENT") {
    const delta = isExpectedFinite && isPaidFinite ? Math.max(paid - expected, 0) : 0;
    return {
      action: "金額が多く支払われています。管理者確認のうえ、差額返金が必要なら返金証跡を登録してください。",
      refundHint: delta > 0 ? `返金候補額: ${formatJpyc(delta)}` : "返金候補額は明細確認後に判断してください。",
      suggestedRefundAmount: delta > 0 ? delta : null,
      suggestedNextStatus: review.status === "open" ? "in_progress" : review.status,
      priorityLabel: priority.label,
    };
  }
  if (reasonType === "DUPLICATE_PAYMENT" || reasonType === "SPLIT_PAYMENT") {
    return {
      action: "同じ請求に追加の支払いが届いています。管理者確認のうえ、必要なら返金証跡を登録してください。",
      refundHint: isPaidFinite ? `返金候補額: ${formatJpyc(paid)}` : "返金候補額は入金明細から確認してください。",
      suggestedRefundAmount: isPaidFinite ? paid : null,
      suggestedNextStatus: review.status === "open" ? "in_progress" : review.status,
      priorityLabel: priority.label,
    };
  }
  if (reasonType === "LATE_PAYMENT") {
    return {
      action: "期限後に支払いが届きました。商品提供状況と照合し、管理者確認のうえ対応してください。",
      refundHint: isPaidFinite ? `返金候補額: ${formatJpyc(paid)}` : "返金要否を個別確認してください。",
      suggestedRefundAmount: isPaidFinite ? paid : null,
      suggestedNextStatus: review.status === "open" ? "in_progress" : review.status,
      priorityLabel: priority.label,
    };
  }
  if (reasonType === "UNDERPAYMENT") {
    return {
      action: "金額が不足しています。同じ請求への追加送金は案内せず、店長承認後の別請求または会計調整を選んでください。",
      refundHint: "返金よりも不足額の取り扱い確認が優先です。",
      suggestedRefundAmount: null,
      suggestedNextStatus: review.status === "open" ? "in_progress" : review.status,
      priorityLabel: priority.label,
    };
  }
  if (["CHAIN_INCONSISTENT", "UNKNOWN_TRANSFER", "ADDRESS_MISMATCH"].includes(reasonType)) {
    return {
      action: "送金条件が一致していません。管理者確認のうえ、必要なら返金証跡を登録してください。",
      refundHint: isPaidFinite ? `返金候補額: ${formatJpyc(paid)}` : "返金候補額は取引明細から確認してください。",
      suggestedRefundAmount: isPaidFinite ? paid : null,
      suggestedNextStatus: review.status === "open" ? "in_progress" : review.status,
      priorityLabel: priority.label,
    };
  }
  if (["CHAIN_REORG", "LEDGER_INTEGRITY_ERROR", "CHAIN_TRANSFER_IDENTITY_INCOMPLETE", "TIMESTAMP_UNVERIFIED", "CROSS_INVOICE_TRANSFER_COLLISION"].includes(reasonType)) {
    return {
      action: "記録の安全確認が完了していません。提供・返金・日次締めを進めず、チェーン記録と会計台帳を管理者が照合してください。",
      refundHint: "返金先と原資の証跡が確定するまで返金申請を作成しないでください。",
      suggestedRefundAmount: null,
      suggestedNextStatus: review.status === "open" ? "in_progress" : review.status,
      priorityLabel: priority.label,
    };
  }
  if (reasonType === "DETECTED_AFTER_EXPIRY") {
    return {
      action: "期限後に検知された支払いです。商品提供状況・新しい請求・取引時刻を照合し、二重提供や二重返金を避けてください。",
      refundHint: isPaidFinite ? `返金候補額: ${formatJpyc(paid)}。提供状況を確認してから判断してください。` : "返金要否は提供状況と取引明細を確認して判断してください。",
      suggestedRefundAmount: isPaidFinite ? paid : null,
      suggestedNextStatus: review.status === "open" ? "in_progress" : review.status,
      priorityLabel: priority.label,
    };
  }
  return {
    action: "取引番号と請求内容を確認し、必要なら in_progress にして担当者メモを残してください。",
    refundHint: "返金要否は明細確認後に判断してください。",
    suggestedRefundAmount: null,
    suggestedNextStatus: review.status === "open" ? "in_progress" : review.status,
    priorityLabel: priority.label,
  };
}

async function loadOpsSnapshot() {
  const sessionGeneration = captureSessionGeneration();
  const canReadReviews = hasPermission("review.read");
  const canReadSettlement = hasPermission("settlement.close");
  const canReadMonitor = hasPermission("monitor.read");
  if (!hasAnyPermission(["review.read", "settlement.close", "monitor.read"]) || !el.businessDateInput) return;
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(String(el.businessDateInput.value || "").trim())
    ? String(el.businessDateInput.value || "").trim()
    : nowIsoDate();
  const snapshotSequence = state.opsSnapshotSequence + 1;
  state.opsSnapshotSequence = snapshotSequence;
  state.opsSnapshotBusinessDate = businessDate;
  state.opsReviewReadState = canReadReviews ? "loading" : "not_permitted";
  state.opsSettlementReadState = canReadSettlement ? "loading" : "not_permitted";
  state.opsReviewBusinessDate = businessDate;
  el.opsSnapshotState.textContent = "運用サマリーを更新中です。";
  try {
    const [reviewsResult, settlementResult, monitorResult] = await Promise.allSettled([
      canReadReviews ? requestJson("/api/v1/reviews") : Promise.resolve(null),
      canReadSettlement
        ? requestJson(`/api/v1/settlements/daily-status?business_date=${encodeURIComponent(businessDate)}`)
        : Promise.resolve(null),
      canReadMonitor ? requestJson("/api/v1/chain-monitor/status") : Promise.resolve(null),
    ]);

    if (
      !isSessionGenerationCurrent(sessionGeneration)
      || snapshotSequence !== state.opsSnapshotSequence
      || state.opsSnapshotBusinessDate !== businessDate
      || String(el.businessDateInput.value || "").trim() !== businessDate
    ) return { status: "stale" };
    const ignoredResult = [reviewsResult, settlementResult, monitorResult].find(
      (result) => result.status === "rejected" && isIgnoredRequestError(result.reason)
    );
    if (ignoredResult) return { status: "stale" };

    const reviewsAvailable = Boolean(
      canReadReviews && reviewsResult.status === "fulfilled" && Array.isArray(reviewsResult.value?.reviews)
    );
    state.opsReviewReadState = reviewsAvailable ? "ok" : canReadReviews ? "failed" : "not_permitted";
    const reviews = reviewsAvailable
      ? [...reviewsResult.value.reviews]
      : [];
    const sortedReviews = reviews.sort(compareReviewsByPriority);
    const activeReviews = sortedReviews.filter((row) => ["open", "in_progress"].includes(String(row.status || "")));
    const openReviewCount = reviewsAvailable ? activeReviews.length : null;
    const priorityReview = activeReviews[0] || null;
    const refundCandidateCount = reviewsAvailable
      ? activeReviews.filter((row) => isRefundCandidateReason(row.reason_type)).length
      : null;

    const monitor = canReadMonitor && monitorResult.status === "fulfilled" ? monitorResult.value : null;
    const pendingDead = monitor ? Number(monitor.pending_dead_letter_count || 0) : null;
    const abandonedDead = monitor ? Number(monitor.abandoned_dead_letter_count || 0) : null;
    const unmatchedCount = monitor ? Number(monitor.unmatched_event_count || 0) : null;
    const failoverCount = monitor ? Number(monitor.failover_count || 0) : null;
    const deadLabel =
      !canReadMonitor
        ? "権限対象外"
        : pendingDead == null || abandonedDead == null
        ? "取得失敗"
        : `${pendingDead + abandonedDead}件`;

    const settlementClosed = canReadSettlement && settlementResult.status === "fulfilled"
      ? settlementResult.value?.closed === true
      : null;
    const settlementAvailable = Boolean(canReadSettlement && settlementResult.status === "fulfilled");
    state.opsSettlementReadState = settlementAvailable
      ? "ok"
      : canReadSettlement
        ? "failed"
        : "not_permitted";
    const settlementReviewCount = canReadSettlement && settlementResult.status === "fulfilled"
      ? Number(settlementResult.value?.settlement?.review_count || 0)
      : null;

    renderOpsWarningsList(
      monitor
        ? buildMonitorWarnings(monitor)
        : [canReadMonitor ? "監視状態を取得できませんでした" : "監視状態は現在の実効権限の対象外です"]
    );

    const addressPoolCount = monitor != null ? Number(monitor.address_pool_available_count ?? -1) : null;
    const monitorStateRows = Array.isArray(monitor?.state) ? monitor.state : [];
    const workerStaleSec = monitor ? detectWorkerStaleSec(monitorStateRows) : null;
    let workerStatusText;
    if (!canReadMonitor) {
      workerStatusText = "権限対象外";
    } else if (!monitor) {
      workerStatusText = "取得失敗";
    } else if (monitorStateRows.length === 0) {
      workerStatusText = "状態不明";
    } else if (workerStaleSec === null) {
      workerStatusText = "稼動情報なし";
    } else if (workerStaleSec > WORKER_STALE_WARN_SEC) {
      workerStatusText = `要確認（${Math.floor(workerStaleSec / 60)}分間更新なし）`;
    } else {
      workerStatusText = "正常";
    }

    let recommendedAction = "通常運用";
    const checklist = [];

    if (!reviewsAvailable) {
      recommendedAction = canReadReviews ? "レビュー再取得" : "レビュー確認権限なし";
      checklist.push(
        canReadReviews
          ? "未解決レビュー件数を取得できないため、日次締めは実行できません。通信・権限状態を確認して再取得してください。"
          : "未解決レビューを確認する実効権限がないため、日次締めは実行できません。権限を確認してください。"
      );
    } else if (canReadSettlement && !settlementAvailable) {
      recommendedAction = "締め状態再取得";
      checklist.push("現在の日次締め状態を取得できないため、日次締めは実行できません。通信・権限状態を確認してください。");
    } else if (abandonedDead != null && abandonedDead > 0) {
      recommendedAction = "dead-letter最優先";
      checklist.push(`abandoned dead-letter ${abandonedDead}件を最優先で確認します。`);
    } else if (pendingDead != null && pendingDead > 0) {
      recommendedAction = "dead-letter確認";
      checklist.push(`pending dead-letter ${pendingDead}件を先に確認します。`);
    } else if (priorityReview) {
      const priority = reviewPriorityMeta(priorityReview);
      recommendedAction = priority.label === "最優先" ? "最優先レビュー対応" : "確認待ち一覧の確認";
      checklist.push(`最優先レビュー ${shortId(priorityReview.id)}（${reviewReasonLabel(priorityReview.reason_type)}）から処理します。`);
    } else if (settlementClosed === false) {
      recommendedAction = "日次締め準備";
    } else if (unmatchedCount != null && unmatchedCount > 0) {
      recommendedAction = "未照合確認";
    }

    if (openReviewCount > 0) {
      checklist.push(`未解決レビュー ${openReviewCount}件があります。優先順位を付けて処理します。`);
    }
    if (refundCandidateCount > 0) {
      checklist.push(`返金候補レビュー ${refundCandidateCount}件があります。詳細の候補額を確認して返金フォームへ反映します。`);
    }
    if (unmatchedCount != null && unmatchedCount > 0) {
      checklist.push(`未照合イベント ${unmatchedCount}件があります。請求との突合を確認します。`);
    }
    if (failoverCount != null && failoverCount > 0) {
      checklist.push(`状態更新の再試行が ${failoverCount}回発生しています。サポートに健全性確認を依頼します。`);
    }
    if (settlementClosed === false) {
      checklist.push(`${businessDate} の日次締めは未実施です。営業終了時に締め処理を行います。`);
    }
    if (settlementClosed === true) {
      checklist.push(`${businessDate} の日次締めは完了済みです。`);
      if (settlementReviewCount != null && settlementReviewCount > 0) {
        checklist.push(`締め時点で未解決レビューが ${settlementReviewCount}件あります。証跡と対応状況を確認します。`);
      }
    }
    if (addressPoolCount != null && addressPoolCount >= 0 && addressPoolCount <= ADDRESS_POOL_WARN_THRESHOLD) {
      checklist.push(`受取アドレス残数が ${addressPoolCount} 件です。新規請求が作れなくなる前に補充してください。`);
    }
    if (workerStatusText !== "正常" && workerStatusText !== "-" && monitor) {
      checklist.push(`状態更新: ${workerStatusText}`);
    }

    el.opsAddressPoolCount.textContent =
      !canReadMonitor
        ? "権限対象外"
        : addressPoolCount != null && addressPoolCount >= 0
        ? `${addressPoolCount}件${addressPoolCount <= ADDRESS_POOL_WARN_THRESHOLD ? "（要補充）" : ""}`
        : "取得失敗";
    el.opsWorkerStatus.textContent = workerStatusText || "-";

    el.opsOpenReviewCount.textContent = !canReadReviews
      ? "権限対象外"
      : reviewsAvailable
        ? `${openReviewCount}件`
        : "取得失敗";
    el.opsDeadLetterCount.textContent = deadLabel;
    el.opsSettlementStatus.textContent =
      !canReadSettlement
        ? "権限対象外"
        : settlementClosed == null
        ? "取得失敗"
        : settlementClosed
          ? settlementReviewCount && settlementReviewCount > 0
            ? `完了（要確認 ${settlementReviewCount}件）`
            : "完了"
          : "未実施";
    el.opsRecommendedAction.textContent = recommendedAction;
    el.opsPriorityReview.textContent = !canReadReviews
      ? "権限対象外"
      : !reviewsAvailable
        ? "取得失敗"
        : priorityReview
          ? `${reviewReasonLabel(priorityReview.reason_type)} / ${shortId(priorityReview.id)}`
          : "なし";
    el.opsRefundCandidateCount.textContent = !canReadReviews
      ? "権限対象外"
      : reviewsAvailable
        ? `${refundCandidateCount}件`
        : "取得失敗";
    el.opsSnapshotState.textContent =
      reviewsAvailable && (!canReadSettlement || settlementAvailable)
        ? "サーバーが返した実効権限の範囲で review / settlement / monitor を集約しています。"
        : "レビュー件数または日次締め状態を確認できていません。日次締めは安全のため停止しています。";
    setChecklist(el.opsSnapshotChecklist, checklist);
    return { status: reviewsAvailable && (!canReadSettlement || settlementAvailable) ? "ok" : "close_preflight_failed" };
  } catch (error) {
    if (
      isIgnoredRequestError(error)
      || !isSessionGenerationCurrent(sessionGeneration)
      || snapshotSequence !== state.opsSnapshotSequence
      || state.opsSnapshotBusinessDate !== businessDate
    ) return { status: "stale" };
    state.opsReviewReadState = canReadReviews ? "failed" : "not_permitted";
    state.opsSettlementReadState = canReadSettlement ? "failed" : "not_permitted";
    el.opsOpenReviewCount.textContent = "-";
    el.opsDeadLetterCount.textContent = "-";
    el.opsSettlementStatus.textContent = "-";
    el.opsRecommendedAction.textContent = "再取得";
    el.opsPriorityReview.textContent = "-";
    el.opsRefundCandidateCount.textContent = "-";
    el.opsAddressPoolCount.textContent = "-";
    el.opsWorkerStatus.textContent = "-";
    el.opsSnapshotState.textContent = "運用サマリーの取得に失敗しました。";
    renderOpsWarningsList(["監視状態を取得できませんでした"]);
    setChecklist(el.opsSnapshotChecklist, ["ネットワークまたは権限状態を確認してから再取得してください。"]);
    return { status: "failed" };
  }
}

function startOpsAutoRefresh() {
  if (state.autoRefreshTimer !== null) return;
  state.autoRefreshTimer = setInterval(() => {
    if (hasAnyPermission(["review.read", "settlement.close", "monitor.read"])) void loadOpsSnapshot();
  }, OPS_AUTO_REFRESH_INTERVAL_MS);
}

function stopOpsAutoRefresh() {
  if (state.autoRefreshTimer === null) return;
  clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = null;
}

function setSseStatus(status, reason = "") {
  state.sseStatus = status;
  state.sseReason = reason || "";
  state.sseUpdatedAt = nowIso();
  renderConnectionStatus();
  renderDiagnostics();
  renderFulfillmentSafetySurfaces();
}

function setFallbackPollingStatus(status, reason = "") {
  state.fallbackPollingStatus = status;
  state.fallbackPollingReason = reason || "";
  state.fallbackPollingUpdatedAt = nowIso();
  renderConnectionStatus();
  renderDiagnostics();
  renderFulfillmentSafetySurfaces();
}

function renderDiagnostics() {
  if (!state.diagnosticsEnabled) {
    el.diagnosticsCard.classList.add("hidden");
    setDiagnosticsBadge("無効");
    el.diagnosticsUpdatedText.textContent = "-";
    el.diagnosticsDumpText.textContent = "診断モードは無効です。";
    return;
  }

  el.diagnosticsCard.classList.remove("hidden");
  const invoice = state.currentInvoice;
  const diagnostics = state.invoiceDiagnostics || {};
  const walletAdapter = diagnostics.wallet_adapter || {};
  const reissue = diagnostics.reissue || {};
  const history = Array.isArray(reissue.history) ? reissue.history : [];
  const lines = [
    "[runtime]",
    `diagnostic_mode_enabled: ${state.diagnosticsEnabled}`,
    `fixed_qr_url: ${state.fixedQrUrl || "-"}`,
    `invoice_id: ${state.invoiceId || "-"}`,
    `invoice_status: ${invoice?.status || "-"}`,
    `status_reason: ${invoice?.status_reason || diagnostics.status_reason || "-"}`,
    `review_reason_type: ${diagnostics.review_reason_type || "-"}`,
    `last_invoice_refresh_at: ${formatDateTime(state.lastInvoiceRefreshAt)}`,
    "",
    "[wallet_launch_payload]",
    `payment_uri: ${diagnostics.payment_uri || "-"}`,
    `wallet_deeplink: ${diagnostics.wallet_deeplink || "-"}`,
    `wallet_url: ${diagnostics.wallet_url || "-"}`,
    `wallet_adapter_status: ${walletAdapter.status || "-"}`,
    `wallet_adapter_reason: ${walletAdapter.reason || "-"}`,
    `supported_wallets: ${(diagnostics.supported_wallets || []).join(", ") || "-"}`,
    "",
    "[payment_spec]",
    `chain_id: ${diagnostics.chain_id || invoice?.chain?.chain_id || "-"}`,
    `network: ${diagnostics.network || "-"}`,
    `token_symbol: ${diagnostics.token_symbol || "-"}`,
    `token_contract: ${diagnostics.token_contract || invoice?.chain?.token_contract || "-"}`,
    `token_decimals: ${diagnostics.token_decimals ?? "-"}`,
    `receive_address: ${diagnostics.receive_address || invoice?.chain?.recipient_address || "-"}`,
    `expected_amount_atomic: ${diagnostics.expected_amount_atomic || "-"}`,
    `pay_url: ${diagnostics.pay_url || invoice?.pay_url || "-"}`,
    `payment_url: ${diagnostics.payment_url || invoice?.payment_url || "-"}`,
    "",
    "[expiry_and_monitoring]",
    `expires_at: ${diagnostics.expires_at || invoice?.expires_at || "-"}`,
    `ttl_remaining: ${formatTtl(diagnostics.expires_at || invoice?.expires_at)}`,
    `sse_connection: ${state.sseStatus}${state.sseReason ? ` (${state.sseReason})` : ""}`,
    `sse_updated_at: ${formatDateTime(state.sseUpdatedAt)}`,
    `last_stream_event_at: ${formatDateTime(state.lastStreamEventAt)}`,
    `polling_fallback: ${state.fallbackPollingStatus}${state.fallbackPollingReason ? ` (${state.fallbackPollingReason})` : ""}`,
    `polling_updated_at: ${formatDateTime(state.fallbackPollingUpdatedAt)}`,
    `last_fallback_poll_at: ${formatDateTime(state.lastFallbackPollAt)}`,
    "",
    "[copy_fallback]",
    stringifyJson(diagnostics.copy_fallback || {}),
    "",
    "[reissue]",
    `root_invoice_id: ${reissue.root_invoice_id || "-"}`,
    `latest_invoice_id: ${reissue.latest_invoice_id || "-"}`,
    `total_versions: ${reissue.total_versions ?? 0}`,
  ];
  if (history.length > 0) {
    lines.push("reissue_history:");
    for (const row of history) {
      lines.push(
        `- ${row.invoice_id} | ${row.status || "-"} | ${row.receive_address || "-"} | ${formatDateTime(row.created_at)}`
      );
    }
  } else {
    lines.push("reissue_history: -");
  }
  lines.push("");
  lines.push("[notes]");
  lines.push("latest_wallet_launch_failure_reason: n/a (terminal UI does not launch customer wallet)");

  state.diagnosticsUpdatedAt = nowIso();
  setDiagnosticsBadge("有効");
  el.diagnosticsUpdatedText.textContent = formatDateTime(state.diagnosticsUpdatedAt);
  el.diagnosticsDumpText.textContent = lines.join("\n");
}

function removeToast(toast) {
  if (!toast) return;
  if (toast.dismissTimer) clearTimeout(toast.dismissTimer);
  toast.remove();
}

function scheduleToastRemoval(toast) {
  if (toast.dismissTimer) clearTimeout(toast.dismissTimer);
  toast.dismissTimer = setTimeout(() => {
    removeToast(toast);
  }, 5000);
}

function showToast(message, isError = false) {
  const normalizedMessage = String(message || "").trim();
  if (!normalizedMessage) return;
  const existingToasts = Array.from(el.toastHost.children);
  const duplicate = existingToasts.find((toast) => toast.dataset.toastMessage === normalizedMessage);
  if (duplicate) {
    if (!isError) {
      for (const toast of existingToasts) {
        if (toast !== duplicate && toast.dataset.toastKind === "success") removeToast(toast);
      }
    }
    duplicate.className = `toast ${isError ? "toast-error" : "toast-info"}`;
    duplicate.dataset.toastKind = isError ? "error" : "success";
    el.toastHost.appendChild(duplicate);
    scheduleToastRemoval(duplicate);
    return;
  }
  if (!isError) {
    for (const toast of existingToasts) {
      if (toast.dataset.toastKind === "success") removeToast(toast);
    }
  }
  const toast = document.createElement("div");
  toast.textContent = normalizedMessage;
  toast.className = `toast ${isError ? "toast-error" : "toast-info"}`;
  toast.dataset.toastMessage = normalizedMessage;
  toast.dataset.toastKind = isError ? "error" : "success";
  el.toastHost.appendChild(toast);
  while (el.toastHost.children.length > 2) {
    removeToast(el.toastHost.firstElementChild);
  }
  scheduleToastRemoval(toast);
}

function clearLoginError() {
  if (!el.loginError) return;
  el.loginError.textContent = "";
  el.loginError.classList.add("hidden");
  for (const input of [el.terminalCode, el.staffName, el.staffPin]) {
    input?.removeAttribute("aria-invalid");
  }
}

function showLoginError(message, focusTarget = el.loginError) {
  clearLoginError();
  if (!el.loginError) return;
  el.loginError.textContent = String(message || "ログインできませんでした。入力内容を確認してください。");
  el.loginError.classList.remove("hidden");
  if (focusTarget && focusTarget !== el.loginError) focusTarget.setAttribute("aria-invalid", "true");
  window.setTimeout(() => focusTarget?.focus?.(), 0);
}

function loginErrorMessage(error) {
  const code = String(error?.code || "").toUpperCase();
  const lockedUntil = error?.payload?.error?.details?.locked_until;
  if (code === "PIN_LOCKED") {
    return lockedUntil
      ? `ログイン試行が一時停止されています。${formatDateTime(lockedUntil)}以降に再試行するか、管理者へ連絡してください。`
      : "ログイン試行が一時停止されています。時間をおいて再試行するか、管理者へ連絡してください。";
  }
  if (code === "RATE_LIMITED") return "ログイン試行が多すぎます。時間をおいてから再試行してください。";
  if (code === "VALIDATION_ERROR") return "端末コード、スタッフ名、4〜8桁のスタッフPINを確認してください。";
  if (code === "UNAUTHORIZED" || error?.status === 401) return "ログイン情報を確認できませんでした。端末コード、スタッフ名、スタッフPINを確認してください。";
  return "ログインできませんでした。通信状態を確認して、もう一度お試しください。";
}

function setLoggedInUi(loggedIn) {
  if (el.loginFormPanel) el.loginFormPanel.classList.toggle("collapsed-after-login", loggedIn);
  if (el.logoutBtn) {
    el.logoutBtn.classList.toggle("hidden", !loggedIn);
    if (loggedIn) el.logoutBtn.textContent = "担当者を交代（ログアウト）";
  }
  if (el.sessionRolePill) {
    el.sessionRolePill.textContent = loggedIn ? formatRole(state.role) : "未ログイン";
    el.sessionRolePill.className = `role-pill ${loggedIn && state.role !== "staff" && state.role !== "operator" ? "role-admin" : "role-staff"}`;
  }
}

function updateRefundStepState(statusText = "") {
  const hasRefundId = Boolean(String(el.refundIdInput?.value || "").trim());
  const currentSignature = buildRefundRequestSignature();
  const storedRequest = state.refundRequestOperations.get(currentSignature);
  const alreadyCreated = Boolean(currentSignature && (storedRequest?.completed || state.refundRequestCompletedSignature === currentSignature));
  const refundStatus = String(state.currentRefund?.status || "");
  const operationInFlight = (kind) => [...state.refundOperationsInFlight].some((entry) => entry.startsWith(`${kind}:`));
  const currentRefundId = String(el.refundIdInput?.value || "").trim();
  const currentRefundBusy = Boolean(currentRefundId && state.refundOperationTargetsInFlight.has(currentRefundId));
  const approvedStatuses = new Set(["approved", "recorded", "pending_verification", "verification_failed", "failed", "succeeded", "finalized"]);
  const evidenceStatuses = new Set(["recorded", "pending_verification", "verification_failed", "failed", "succeeded", "finalized"]);
  const completedStatuses = new Set(["succeeded", "finalized"]);
  const currentStepIndex = !hasRefundId ? 0 : approvedStatuses.has(refundStatus) ? 2 : 1;
  const panels = [el.refundStepRequestPanel, el.refundStepApprovePanel, el.refundStepEvidencePanel];
  panels.forEach((panel, index) => {
    if (!panel) return;
    const stepState = index < currentStepIndex || (index === 2 && completedStatuses.has(refundStatus))
      ? "completed"
      : index === currentStepIndex
        ? "current"
        : "future";
    panel.dataset.stepState = stepState;
    panel.classList.toggle("current", stepState === "current");
    panel.classList.toggle("completed", stepState === "completed");
    if (stepState === "current") panel.setAttribute("aria-current", "step");
    else panel.removeAttribute("aria-current");
  });
  if (el.refundStepRequestBadge) el.refundStepRequestBadge.textContent = hasRefundId ? "作成済み" : "入力";
  if (el.refundStepApproveBadge) {
    el.refundStepApproveBadge.textContent = approvedStatuses.has(refundStatus) ? "承認済み" : hasRefundId ? "承認待ち" : "返金ID待ち";
  }
  if (el.refundStepEvidenceBadge) {
    el.refundStepEvidenceBadge.textContent = completedStatuses.has(refundStatus)
      ? "検証済み"
      : statusText || (evidenceStatuses.has(refundStatus) ? refundStatusLabel(refundStatus) : hasRefundId ? "承認後に入力" : "返金ID待ち");
  }
  if (el.requestRefundBtn) {
    const payerMatchesReview = state.refundPayerAddressVerified
      && state.refundPayerAddressReviewId === String(el.refundReviewCaseId?.value || "").trim();
    el.requestRefundBtn.disabled = !hasPermission("refund.request")
      || state.refundRequestInFlight
      || alreadyCreated
      || !payerMatchesReview;
  }
  if (el.approveRefundBtn) {
    el.approveRefundBtn.disabled = !hasRefundId || !hasPermission("refund.approve") || currentRefundBusy || operationInFlight("refund-approve");
  }
  if (el.executeRefundBtn) {
    el.executeRefundBtn.disabled = !hasRefundId || !hasPermission("refund.execute") || currentRefundBusy || operationInFlight("refund-execute");
  }
  if (el.verifyRefundBtn) {
    el.verifyRefundBtn.disabled = !hasRefundId || !hasPermission("refund.execute") || currentRefundBusy || operationInFlight("refund-verify");
  }
}

function stopSessionExpiryTimer() {
  if (state.sessionExpiryTimer === null) return;
  clearInterval(state.sessionExpiryTimer);
  state.sessionExpiryTimer = null;
}

function renderSessionExpiry() {
  if (!state.sessionExpiresAt) {
    el.sessionExpiryText.textContent = "-";
    return;
  }
  const remainingMs = new Date(state.sessionExpiresAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    resetSessionUi("セッション期限切れ。再ログインしてください");
    return;
  }
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  el.sessionExpiryText.textContent = `${formatDateTime(state.sessionExpiresAt)}（残り約${remainingMinutes}分）`;
}

function startSessionExpiryTimer() {
  stopSessionExpiryTimer();
  renderSessionExpiry();
  if (!state.token || !state.sessionExpiresAt) return;
  state.sessionExpiryTimer = setInterval(renderSessionExpiry, 30000);
}

function setAuditLogRows(rows) {
  if (!el.auditLogList) return;
  el.auditLogList.replaceChildren();
  const source = Array.isArray(rows) && rows.length > 0 ? rows : [null];
  for (const row of source) {
    const item = document.createElement("li");
    item.textContent = row
      ? `${formatDateTime(row.created_at)} / ${row.action || "-"} / ${row.target_type || "-"} ${shortId(row.target_id || "-")}`
      : "表示できる操作履歴はありません。";
    el.auditLogList.appendChild(item);
  }
}

function resetSessionUi(reason = "未ログイン", options = {}) {
  const logoutRetryToken = String(options.logoutRetryToken || "");
  const logoutIdempotencyKey = String(options.logoutIdempotencyKey || "");
  advanceSessionEpoch();
  invalidateResourceRequests();
  stopSessionExpiryTimer();
  closeSse(reason);
  stopFallbackPolling();
  stopOpsAutoRefresh();
  state.token = "";
  state.terminalId = "";
  state.storeId = "";
  state.sessionId = "";
  state.role = "";
  state.staffName = "";
  state.staffCode = "";
  state.effectivePermissions = new Set();
  state.permissionsKnown = false;
  state.storeTimezone = "Asia/Tokyo";
  state.sessionExpiresAt = "";
  state.diagnosticsEnabled = false;
  state.invoiceDiagnostics = null;
  state.diagnosticsUpdatedAt = "";
  state.supportedWallets = [];
  state.paymentsDisableState = null;
  state.paymentsReadState = "unknown";
  state.storePaymentsControlInFlight = false;
  state.storePaymentsOperation = null;
  state.paymentChains = [];
  state.deploymentTopology = "public_cloud";
  state.fixedQrUrl = "";
  state.fixedQrToken = "";
  state.policyOrigin = "";
  state.policyLinks = null;
  state.invoiceConsent = null;
  state.consentRecordingInFlight = false;
  state.reviewRows = [];
  state.selectedReviewId = "";
  state.selectedReviewDetail = null;
  state.reviewDrafts = new Map();
  state.reviewDraftBindingId = "";
  state.reviewDraftDirty = false;
  state.pendingReviewUpdate = "";
  state.opsReviewReadState = "unavailable";
  state.opsSettlementReadState = "unavailable";
  state.opsReviewBusinessDate = "";
  state.pendingDangerAction = "";
  state.invoiceOperationsInFlight = new Set();
  state.invoiceOperationKeys = new Map();
  clearPendingRefundExecute();
  state.pendingSettlementClose = "";
  state.settlementCloseInFlight = false;
  state.settlementPreviewInFlight = false;
  state.settlementOperationKeys = new Map();
  state.settlementPreview = null;
  state.settlementPreviewSignature = "";
  state.settlementExport = null;
  state.accountingAdjustmentOperations = new Map();
  state.accountingAdjustmentInFlight = new Set();
  state.pendingAdjustmentRows = [];
  state.pendingAdjustmentSelectedId = "";
  state.refundRequestInFlight = false;
  state.refundRequestSignature = "";
  state.refundRequestIdempotencyKey = "";
  state.refundRequestCompletedSignature = "";
  state.refundRequestOperations = new Map();
  state.refundOperationsInFlight = new Set();
  state.refundOperationTargetsInFlight = new Set();
  state.refundOperationKeys = new Map();
  state.currentRefund = null;
  state.refundPayerAddressVerified = false;
  state.refundPayerAddressReviewId = "";
  stopCompletedInvoiceAutoReset();
  state.logoutInFlight = false;
  state.logoutRetryToken = logoutRetryToken;
  state.logoutIdempotencyKey = logoutIdempotencyKey;

  clearInvoiceView();
  el.staffPin.value = "";
  clearLoginError();
  el.staffName.value = "";
  el.amountInput.value = "";
  loadTerminalSettings();
  renderPaymentChains([]);
  el.sessionIdentityText.textContent = "未ログイン";
  el.sessionRoleText.textContent = "-";
  el.sessionText.textContent = reason;
  el.sessionExpiryText.textContent = "-";
  el.sessionPermissionText.textContent = "ログイン後、サーバーが返した実効権限に応じて操作を表示します。";
  if (el.businessTimezoneText && el.reviewsTableBody) {
    el.businessTimezoneText.textContent = state.storeTimezone;
    el.businessDateInput.value = nowIsoDate();
    el.businessMonthInput.value = nowIsoDate().slice(0, 7);
    el.reviewsTableBody.replaceChildren();
    renderReviewSummary([]);
    renderReviewDetail(null);
    el.reviewIdInput.value = "";
    el.reviewDisposition.value = "";
    el.reviewIncidentId.value = "";
    el.reviewNote.value = "";
    el.reviewStepUpPin.value = "";
    el.reviewAdjustmentInvoiceId.value = "";
    el.reviewAdjustmentId.value = "";
    el.reviewAdjustmentAmount.value = "";
    el.reviewAdjustmentReason.value = "";
    el.reviewAdjustmentEvidenceRef.value = "";
    renderPendingAccountingAdjustments([]);
    el.accountingAdjustmentStatus.textContent = "再ログイン後に確認待ち一覧を読み込めます。";
    setReviewListState("empty", "再ログイン後に確認待ち一覧を読み込めます。");
    el.refundReviewCaseId.value = "";
    el.refundAmount.value = "";
    el.refundAddress.value = "";
    el.refundChainId.value = "";
    el.refundIdInput.value = "";
    el.refundTxHashInput.value = "";
    el.refundExecutedWalletInput.value = "";
    el.refundEvidenceNotePathInput.value = "";
    el.refundCustomerNoteInput.value = "";
    el.refundEligibleHint.textContent = "レビューを選択すると、サーバーが返した返金可能額を表示します。";
    el.executeRefundHint.classList.add("hidden");
    el.executeRefundHint.textContent = "";
    clearSettlementPreview();
    el.settlementExportPanel.classList.add("hidden");
    el.settlementExportId.textContent = "-";
    el.settlementExportRunId.textContent = "-";
    el.settlementExportVersion.textContent = "-";
    el.settlementExportHash.textContent = "-";
    el.closeSettlementHint.classList.add("hidden");
    el.closeSettlementHint.textContent = "";
    el.auditLogPanel.classList.add("hidden");
    setAuditLogRows([]);
    el.opsOpenReviewCount.textContent = "-";
    el.opsDeadLetterCount.textContent = "-";
    el.opsSettlementStatus.textContent = "-";
    el.opsRecommendedAction.textContent = "-";
    el.opsPriorityReview.textContent = "-";
    el.opsRefundCandidateCount.textContent = "-";
    el.opsAddressPoolCount.textContent = "-";
    el.opsWorkerStatus.textContent = "-";
    el.opsSnapshotState.textContent = "再ログイン後に実効権限の範囲で運用サマリーを表示します。";
    setChecklist(el.opsSnapshotChecklist, ["担当者を交代する場合は、次のスタッフでログインしてください。"]);
  }
  renderOpsWarningsList(["ログイン後に運用状態を確認します"]);
  setLoggedInUi(false);
  if (logoutRetryToken) {
    if (el.loginFormPanel) el.loginFormPanel.classList.add("collapsed-after-login");
    el.loginBtn.disabled = true;
    el.logoutBtn.classList.remove("hidden");
    el.logoutBtn.textContent = "ログアウトを再試行";
    el.logoutBtn.disabled = false;
    el.sessionRolePill.textContent = "ログアウト確認待ち";
    el.sessionRolePill.className = "role-pill role-admin";
    el.sessionIdentityText.textContent = "機密情報を非表示にしました";
    el.sessionText.textContent = reason;
    el.sessionPermissionText.textContent =
      "サーバー側のログアウト完了を確認できていません。同じセッションでログアウトを再試行するまで新規操作とログインを停止しています。";
    window.setTimeout(() => el.logoutBtn?.focus(), 0);
  } else {
    el.loginBtn.disabled = false;
    el.logoutBtn.textContent = "担当者を交代（ログアウト）";
    window.setTimeout(() => el.staffName?.focus(), 0);
  }
  applyPermissionVisibility();
  updateRefundStepState();
  setNetworkStatus("未接続");
}

function syncInvoiceOperationControls() {
  const canCreate = hasPermission("invoice.create");
  const canIssuePayment = canCreate && paymentIssuanceAllowed();
  const busy = state.invoiceOperationsInFlight.size > 0;
  const hasPaymentChain = Boolean(el.paymentChainSelect?.value);
  if (el.createInvoiceBtn) el.createInvoiceBtn.disabled = !canIssuePayment || busy || !hasPaymentChain;
  if (el.paymentChainSelect) el.paymentChainSelect.disabled = !canIssuePayment || busy || state.paymentChains.length === 0;
  if (el.cancelInvoiceBtn) el.cancelInvoiceBtn.disabled = !canCreate || busy || !state.invoiceId;
  if (el.expireInvoiceBtn) el.expireInvoiceBtn.disabled = !canCreate || busy || !state.invoiceId;
  if (el.reissueInvoiceBtn) el.reissueInvoiceBtn.disabled = !canIssuePayment || busy || !state.invoiceId;
  if (state.currentInvoice) renderProviderControls(state.currentInvoice);
}

function beginInvoiceOperation(kind, signature, { stable = true } = {}) {
  if (state.invoiceOperationsInFlight.size > 0) return null;
  const operationSignature = `${kind}:${String(signature || "")}`;
  state.invoiceOperationsInFlight.add(operationSignature);
  syncInvoiceOperationControls();
  return {
    operationSignature,
    idempotencyKey: stable
      ? getStableOperationKey(state.invoiceOperationKeys, kind, signature)
      : idempotencyKey(kind),
  };
}

function endInvoiceOperation(operation) {
  if (operation?.operationSignature) state.invoiceOperationsInFlight.delete(operation.operationSignature);
  syncInvoiceOperationControls();
}

function confirmDangerInvoiceAction(actionPath, label) {
  if (!requireUiPermission("invoice.create", label)) return;
  if (!state.invoiceId) {
    showToast("対象の請求がありません", true);
    return;
  }
  const targetInvoiceId = state.invoiceId;
  const actionSignature = `${targetInvoiceId}:${actionPath}`;
  if (state.pendingDangerAction !== actionSignature) {
    state.pendingDangerAction = actionSignature;
    showToast(`${label}するには、同じボタンをもう一度押してください`, true);
    window.setTimeout(() => {
      if (state.pendingDangerAction === actionSignature) state.pendingDangerAction = "";
    }, 5000);
    return;
  }
  state.pendingDangerAction = "";
  void postInvoiceAction(actionPath, `${label}しました`, targetInvoiceId);
}

function parseErrorMessage(data, fallback = "リクエストに失敗しました") {
  return operatorErrorMessage(data?.error?.code, fallback);
}

function operatorErrorMessage(code, fallback = "操作を完了できませんでした") {
  const normalized = String(code || "").trim().toUpperCase();
  const messages = {
    VALIDATION_ERROR: "入力内容を確認してください。",
    UNAUTHORIZED: "認証できませんでした。担当者情報を確認して再ログインしてください。",
    FORBIDDEN: "この操作を行う権限がありません。管理者へ確認してください。",
    NOT_FOUND: "対象データを確認できませんでした。一覧を更新してください。",
    RATE_LIMITED: "操作が集中しています。少し待ってから再試行してください。",
    STEP_UP_REQUIRED: "この操作には新しいstep-up確認が必要です。担当者PINを再入力してください。",
    TWO_PERSON_REQUIRED: "作成者とは別のスタッフでログインして承認してください。",
    INVALID_STATE_TRANSITION: "対象の状態が変わったため操作できません。一覧を更新してください。",
    ACCOUNTING_ADJUSTMENT_CONFLICT: "会計調整が同時に更新されました。確認待ち一覧を更新してください。",
    CUSTOMER_DESTINATION_APPROVAL_CHALLENGE_REQUIRED: "代替返金先にはお客様の署名確認が必要です。この端末では代替先を受け付けないため、選択レビューの支払い元アドレスを使用してください。",
    CUSTOMER_DESTINATION_APPROVAL_CHALLENGE_INVALID: "代替返金先の署名確認が一致しません。この端末では代替先を受け付けません。",
    CUSTOMER_DESTINATION_APPROVAL_NONCE_INVALID: "代替返金先の確認情報が無効または期限切れです。この端末では代替先を受け付けません。",
    PAYER_ADDRESS_NOT_UNAMBIGUOUS: "支払い元アドレスを一意に確認できないため、返金申請を停止しました。取引証跡を管理者が確認してください。",
    UNRESOLVED_REVIEWS: "未解決レビューがあるため日次締めを実行できません。",
    UNRESOLVED_REFUNDS: "未完了の返金記録があるため日次締めを実行できません。",
    ACTIVE_INVOICES_BLOCK_CLOSE: "処理中の請求があるため日次締めを実行できません。",
    ACCOUNTING_FINALITY_PENDING: "会計確定に必要な確認数が不足しているため、日次締めを停止しました。",
    SETTLEMENT_HARD_GATE_BLOCKED: "安全確認項目が未完了のため、日次締めを停止しました。",
    SETTLEMENT_EXPORT_HASH_MISMATCH: "正式snapshotのhashが一致しないため、ダウンロードを停止しました。",
    PRIVACY_POLICY_NOT_APPROVED: "プライバシー承認が完了していないため、監査出力を停止しました。",
  };
  if (messages[normalized]) return messages[normalized];
  return normalized
    ? `${fallback}（運用問い合わせコード: ${normalized}）`
    : fallback;
}

function advanceSessionEpoch() {
  state.sessionEpoch += 1;
  for (const controller of state.requestControllers) {
    controller.abort();
  }
  state.requestControllers.clear();
}

function captureSessionGeneration() {
  return { epoch: state.sessionEpoch, token: state.token };
}

function isSessionGenerationCurrent(generation) {
  return Boolean(
    generation?.token && generation.epoch === state.sessionEpoch && generation.token === state.token
  );
}

function createIgnoredRequestError() {
  const error = new Error("旧セッションの応答を破棄しました");
  error.name = "AbortError";
  error.code = "STALE_SESSION_RESPONSE";
  error.ignored = true;
  return error;
}

function isIgnoredRequestError(error) {
  return Boolean(error?.ignored || error?.code === "STALE_SESSION_RESPONSE" || error?.name === "AbortError");
}

function createRequestTimeoutError(timeoutMs) {
  const error = new Error("通信がタイムアウトしました。ネットワークを確認し、もう一度お試しください。");
  error.code = "REQUEST_TIMEOUT";
  error.timeoutMs = timeoutMs;
  error.retryable = true;
  return error;
}

function createRequestContext(policy = {}, externalSignal = null) {
  const authToken = policy.authToken === undefined ? state.token : String(policy.authToken || "");
  const bindToSession = policy.bindToSession === undefined
    ? Boolean(authToken && authToken === state.token)
    : policy.bindToSession === true;
  const requestedTimeoutMs = Number(policy.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.min(Math.trunc(requestedTimeoutMs), 120_000)
    : API_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const context = {
    authToken,
    bindToSession,
    epoch: state.sessionEpoch,
    resetOn401: policy.resetOn401 === undefined ? bindToSession : policy.resetOn401 === true,
    controller,
    timeoutMs,
    timeoutId: null,
    timedOut: false,
    externallyAborted: false,
    externalSignal,
    externalAbortHandler: null,
  };
  context.timeoutId = setTimeout(() => {
    context.timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (externalSignal) {
    context.externalAbortHandler = () => {
      context.externallyAborted = true;
      controller.abort();
    };
    if (externalSignal.aborted) context.externalAbortHandler();
    else externalSignal.addEventListener("abort", context.externalAbortHandler, { once: true });
  }
  if (bindToSession) state.requestControllers.add(controller);
  return context;
}

function assertRequestContextCurrent(context) {
  if (context.timedOut) throw createRequestTimeoutError(context.timeoutMs);
  if (context.externallyAborted) throw createIgnoredRequestError();
  if (context.bindToSession && (
    context.epoch !== state.sessionEpoch || context.authToken !== state.token
  )) {
    throw createIgnoredRequestError();
  }
}

function releaseRequestContext(context) {
  clearTimeout(context.timeoutId);
  if (context.externalSignal && context.externalAbortHandler) {
    context.externalSignal.removeEventListener("abort", context.externalAbortHandler);
  }
  if (context.bindToSession) state.requestControllers.delete(context.controller);
}

function authHeaders(authToken = state.token) {
  if (!authToken) return {};
  return { authorization: `Bearer ${authToken}` };
}

function createHttpError(response, payload, fallback, context) {
  assertRequestContextCurrent(context);
  if (response.status === 401 && context.resetOn401 && state.token === context.authToken) {
    resetSessionUi("セッションが無効または期限切れです");
  }
  const serverMessage = parseErrorMessage(payload, fallback);
  const message = response.status === 403
    ? `この操作の権限がありません。${serverMessage ? ` ${serverMessage}` : ""}`
    : response.status === 401
      ? `認証できませんでした。${serverMessage ? ` ${serverMessage}` : ""}`
      : serverMessage;
  const error = new Error(message);
  error.status = response.status;
  error.code = payload?.error?.code || "";
  error.payload = payload;
  return error;
}

async function requestJson(path, options = {}, policy = {}) {
  const context = createRequestContext(policy, options.signal || null);
  const headers = {
    ...(options.headers || {}),
    ...authHeaders(context.authToken),
  };
  const fetchOptions = { ...options, headers, signal: context.controller.signal };
  try {
    const response = await fetch(path, fetchOptions);
    assertRequestContextCurrent(context);
    const payload = await response.json().catch(() => ({}));
    assertRequestContextCurrent(context);
    if (!response.ok) {
      throw createHttpError(response, payload, "リクエストに失敗しました", context);
    }
    return payload;
  } catch (error) {
    if (context.timedOut) throw createRequestTimeoutError(context.timeoutMs);
    if (
      isIgnoredRequestError(error) ||
      (context.bindToSession &&
        (context.epoch !== state.sessionEpoch || context.authToken !== state.token))
    ) {
      throw createIgnoredRequestError();
    }
    throw error;
  } finally {
    releaseRequestContext(context);
  }
}

async function requestText(path, options = {}, policy = {}) {
  const context = createRequestContext(policy, options.signal || null);
  const headers = {
    ...(options.headers || {}),
    ...authHeaders(context.authToken),
  };
  const fetchOptions = { ...options, headers, signal: context.controller.signal };
  try {
    const response = await fetch(path, fetchOptions);
    assertRequestContextCurrent(context);
    const body = await response.text();
    assertRequestContextCurrent(context);
    if (!response.ok) {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch (_error) {
        payload = {};
      }
      throw createHttpError(response, payload, body || "リクエストに失敗しました", context);
    }
    return { body, headers: response.headers };
  } catch (error) {
    if (context.timedOut) throw createRequestTimeoutError(context.timeoutMs);
    if (
      isIgnoredRequestError(error) ||
      (context.bindToSession &&
        (context.epoch !== state.sessionEpoch || context.authToken !== state.token))
    ) {
      throw createIgnoredRequestError();
    }
    throw error;
  } finally {
    releaseRequestContext(context);
  }
}

async function requestBytes(path, options = {}, policy = {}) {
  const context = createRequestContext(policy, options.signal || null);
  const headers = {
    ...(options.headers || {}),
    ...authHeaders(context.authToken),
  };
  const fetchOptions = { ...options, headers, signal: context.controller.signal };
  try {
    const response = await fetch(path, fetchOptions);
    assertRequestContextCurrent(context);
    const body = new Uint8Array(await response.arrayBuffer());
    assertRequestContextCurrent(context);
    if (!response.ok) {
      let payload = {};
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch (_error) {
        payload = {};
      }
      throw createHttpError(response, payload, "ダウンロードに失敗しました", context);
    }
    return { body, headers: response.headers };
  } catch (error) {
    if (context.timedOut) throw createRequestTimeoutError(context.timeoutMs);
    if (
      isIgnoredRequestError(error)
      || (context.bindToSession
        && (context.epoch !== state.sessionEpoch || context.authToken !== state.token))
    ) {
      throw createIgnoredRequestError();
    }
    throw error;
  } finally {
    releaseRequestContext(context);
  }
}

async function sha256Hex(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function downloadBytes(body, fileName, contentType) {
  const blob = new Blob([body], { type: contentType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function setInvoiceStatusPill(statusRaw) {
  const status = canonicalInvoiceStatus(statusRaw);
  if (hasIntegrityHold(state.currentInvoice)) {
    el.invoiceStatusPill.textContent = "記録整合性を確認中";
    el.invoiceStatusPill.className = "status-pill s-red";
    return;
  }
  if (isFulfillmentObservationUnavailable(state.currentInvoice)) {
    el.invoiceStatusPill.textContent = "最新状態を再確認中";
    el.invoiceStatusPill.className = "status-pill s-red";
    return;
  }
  const labelMap = {
    issued: ["発行済み", "s-blue"],
    payment_detected: ["入金検知", "s-blue"],
    confirming: ["確認中", "s-blue"],
    paid: ["支払い完了", "s-green"],
    settled: ["確定済み", "s-green"],
    review_required: ["確認が必要", "s-yellow"],
    cancelled: ["無効化", "s-red"],
    expired: ["期限切れ", "s-red"],
  };
  const [label, klass] = labelMap[status] || [status || "未発行", "s-gray"];
  el.invoiceStatusPill.textContent = label;
  el.invoiceStatusPill.className = `status-pill ${klass}`;
}

function clearQrCanvas(canvas, { showEmptyLabel = false } = {}) {
  const rect = canvas.getBoundingClientRect?.();
  const cssSize = Math.max(1, Math.floor(Math.min(rect?.width || canvas.width || 420, rect?.height || canvas.height || 420)));
  const dpr = Math.min(Math.max(Number(window.devicePixelRatio) || 1, 1), 3);
  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  ctx.fillStyle = "#f4f6fb";
  ctx.fillRect(0, 0, cssSize, cssSize);
  if (showEmptyLabel) {
    ctx.fillStyle = "#5a6a82";
    ctx.font = "16px sans-serif";
    ctx.fillText("QRなし", 16, 30);
  }
}

function clearQr() {
  clearQrCanvas(el.qrCanvas, { showEmptyLabel: true });
  if (typeof releaseScreenWakeLock === "function") void releaseScreenWakeLock();
}

function drawQr(value, canvas = el.qrCanvas) {
  if (!value || typeof qrcode !== "function") {
    if (canvas === el.qrCanvas) clearQr();
    else clearQrCanvas(canvas);
    return;
  }
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const quietZoneModules = 4;
  const totalModules = moduleCount + quietZoneModules * 2;
  const rect = canvas.getBoundingClientRect?.();
  const cssSize = Math.max(1, Math.floor(Math.min(rect?.width || canvas.width || 420, rect?.height || canvas.height || 420)));
  const dpr = Math.min(Math.max(Number(window.devicePixelRatio) || 1, 1), 3);
  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  const ctx = canvas.getContext("2d");
  const tile = Math.max(1, Math.floor(cssSize / totalModules));
  const renderedSize = tile * totalModules;
  const offset = Math.floor((cssSize - renderedSize) / 2);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cssSize, cssSize);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cssSize, cssSize);
  ctx.fillStyle = "#132036";
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qr.isDark(row, col)) {
        const x = offset + (col + quietZoneModules) * tile;
        const y = offset + (row + quietZoneModules) * tile;
        ctx.fillRect(x, y, tile, tile);
      }
    }
  }
}

function providerBadgeClass(operatorStateCode) {
  if (operatorStateCode === "fulfillment_ok") return "s-green";
  if (operatorStateCode === "retry_required") return "s-red";
  if (operatorStateCode === "needs_review") return "s-yellow";
  return "s-blue";
}

function renderCustomerFacingDisplay(invoice) {
  const providerSummary = invoice?.provider_summary || null;
  const tapOnly = PROVIDER_RAIL_ENABLED && providerSummary?.qr_available === false;
  el.qrCanvas.classList.toggle("hidden", tapOnly);
  if (el.tapModePanel) el.tapModePanel.classList.toggle("hidden", !tapOnly);
  if (!tapOnly) {
    if (state.deploymentTopology === "local_store_terminal") {
      // No fixed customer entry QR exists in this topology: the displayed QR is
      // the per-invoice wallet transfer URI (chain, token, recipient, exact
      // amount come from the invoice record itself). The transfer URI is only
      // rendered after the server confirmed the per-invoice policy consent
      // row; the server also withholds payment_uri until then.
      const consent = invoice?.customer_policy_consent;
      const consentRecorded = consent?.recorded === true;
      const walletUri = String(invoice?.payment_uri || "").trim();
      const invoiceActive = Boolean(invoice && walletUri) && consentRecorded;
      if (invoiceActive) {
        drawQr(walletUri);
        if (typeof requestScreenWakeLock === "function") void requestScreenWakeLock();
        el.fixedQrUrlLink.textContent = "送金用QR（この会計専用）";
        el.fixedQrUrlLink.removeAttribute("href");
      } else {
        el.fixedQrUrlLink.textContent = "-";
        el.fixedQrUrlLink.removeAttribute("href");
        clearQr();
      }
      el.customerDisplayHint.textContent = !invoiceActive && Boolean(walletUri)
        ? "規約同意の記録が完了していないため、送金QRは表示していません。"
        : invoiceActive
          ? "このQRは現在の会計専用の送金用QRです。お客様のウォレットで読み取って送金してください。"
          : "会計準備中です。規約同意を記録すると、この会計専用の送金用QRが表示されます。";
      return;
    }
    if (state.fixedQrUrl) {
      drawQr(state.fixedQrUrl);
      if (typeof requestScreenWakeLock === "function") void requestScreenWakeLock();
      el.fixedQrUrlLink.textContent = state.fixedQrUrl;
      el.fixedQrUrlLink.href = state.fixedQrUrl;
    } else {
      el.fixedQrUrlLink.textContent = "-";
      el.fixedQrUrlLink.removeAttribute("href");
      clearQr();
    }
    el.customerDisplayHint.textContent =
      "このQRは端末ごとの固定入口です。お客様画面は、その時点の current invoice に一度だけ解決されます。";
    return;
  }

  if (typeof releaseScreenWakeLock === "function") void releaseScreenWakeLock();

  if (hasIntegrityHold(invoice)) {
    el.tapModeBadge.textContent = "記録整合性を確認中";
    el.tapModeBadge.className = "status-pill s-red";
    el.tapModeTitle.textContent = "商品はまだ渡さないでください";
    el.tapModeBody.textContent = "支払い記録の整合性確認が完了するまで、店頭端末の完了案内を保留しています。";
    el.tapModeAmount.textContent = formatJpy(invoice?.amounts?.amount_jpy || 0);
    el.customerDisplayHint.textContent = "追加操作を行わず、スタッフが記録を確認するまでお待ちください。";
    return;
  }

  if (isFulfillmentObservationUnavailable(invoice)) {
    el.tapModeBadge.textContent = "状態再確認中";
    el.tapModeBadge.className = "status-pill s-red";
    el.tapModeTitle.textContent = "商品はまだ渡さないでください";
    el.tapModeBody.textContent = "最新状態の取得が成功するまで、店頭端末の完了案内を保留しています。";
    el.tapModeAmount.textContent = formatJpy(invoice?.amounts?.amount_jpy || 0);
    el.customerDisplayHint.textContent = "追加操作を行わず、スタッフが最新状態を再取得するまでお待ちください。";
    return;
  }

  el.tapModeBadge.textContent = providerSummary.operator_state?.label || "タッチ案内";
  el.tapModeBadge.className = `status-pill ${providerBadgeClass(providerSummary.operator_state?.code)}`;
  el.tapModeTitle.textContent = providerSummary.customer_payment_mode?.title || "カード・スマホをかざしてください";
  el.tapModeBody.textContent =
    providerSummary.customer_payment_mode?.body || providerSummary.operator_state?.body || "店頭端末でタッチ決済をご案内しています。";
  el.tapModeAmount.textContent = formatJpy(invoice?.amounts?.amount_jpy || 0);
  el.customerDisplayHint.textContent =
    "タッチ案内中のため、端末入口QRからのウォレット導線は一時停止しています。QRに戻すときは店員が明示操作を行います。";
}

function renderCustomerFacingQr() {
  renderCustomerFacingDisplay(state.currentInvoice);
}

// The public policy/Site origin (PUBLIC_POLICY_ORIGIN, official key) is
// validated origin-only HTTPS before anything is rendered. Links and the
// guide QR are built only from that validated origin.
function isOriginOnlyHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && parsed.port === ""
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
  } catch (_error) {
    return false;
  }
}

function setPolicyLink(linkEl, href, label) {
  if (!linkEl) return;
  try {
    const parsed = new URL(String(href || ""));
    if (parsed.protocol === "https:" && parsed.origin === state.policyOrigin) {
      linkEl.href = parsed.href;
      linkEl.textContent = label;
      linkEl.classList.remove("hidden");
      return;
    }
  } catch (_error) {
    // Invalid links remain hidden.
  }
  linkEl.classList.add("hidden");
  linkEl.removeAttribute("href");
}

function renderSitesGuide() {
  const host = document.getElementById("sitesGuideCard");
  if (!host) return;
  const origin = String(state.policyOrigin || "").trim();
  if (!origin || !isOriginOnlyHttpsUrl(origin)) {
    state.policyOrigin = "";
    state.policyLinks = null;
    host.classList.add("hidden");
    return;
  }
  const links = state.policyLinks && typeof state.policyLinks === "object" ? state.policyLinks : {};
  setPolicyLink(el.policyTermsLink, links.terms, "利用規約");
  setPolicyLink(el.policyPrivacyLink, links.privacy, "プライバシーポリシー");
  setPolicyLink(el.policyRefundLink, links.refund_policy, "返金ポリシー");
  setPolicyLink(el.policySecurityLink, links.security, "安全対策・誤送金防止");
  if (el.policyGuideQrCanvas) drawQr(origin, el.policyGuideQrCanvas);
  if (el.policyGuideOriginText) el.policyGuideOriginText.textContent = origin;
  host.classList.remove("hidden");
}

function invoiceConsentRequired(invoice = state.currentInvoice) {
  const consent = invoice?.customer_policy_consent;
  return Boolean(consent && consent.required === true);
}

function renderInvoiceConsent() {
  if (!el.invoiceConsentPanel) return;
  const invoice = state.currentInvoice;
  if (state.deploymentTopology !== "local_store_terminal"
    || !invoiceConsentRequired(invoice)
    || invoice?.customer_policy_consent?.recorded === true
    || canonicalInvoiceStatus(invoice?.status) === "cancelled") {
    el.invoiceConsentPanel.classList.add("hidden");
    if (el.invoiceConsentCheckbox) el.invoiceConsentCheckbox.checked = false;
    syncConsentControls();
    return;
  }
  const consent = invoice.customer_policy_consent;
  if (!consent.ready) {
    el.invoiceConsentBadge.textContent = "規約設定未公開";
    el.invoiceConsentBadge.className = "status-pill s-red";
    el.invoiceConsentBody.textContent = "公開済みの規約スナップショットがこの請求に紐づいていません。管理者へ連絡し、新しい請求を作り直してください。送金QRは表示されません。";
    if (el.recordConsentBtn) el.recordConsentBtn.disabled = true;
    if (el.invoiceConsentStatus) el.invoiceConsentStatus.textContent = "";
  } else {
    const versions = consent.versions || {};
    el.invoiceConsentBadge.textContent = "規約同意待ち";
    el.invoiceConsentBadge.className = "status-pill s-yellow";
    el.invoiceConsentBody.textContent =
      `お客様に Site の利用規約・プライバシーポリシー・返金ポリシーを確認してもらい、チェックを付けて記録します。`
      + ` 対象バージョン: terms ${versions.terms_version || "-"} / privacy ${versions.privacy_version || "-"} / refund ${versions.refund_policy_version || "-"}。`
      + ` 同意の記録が完了するまで、この会計の送金QRは表示されません。`;
  }
  el.invoiceConsentPanel.classList.remove("hidden");
  syncConsentControls();
}

function syncConsentControls() {
  if (!el.recordConsentBtn) return;
  const checked = Boolean(el.invoiceConsentCheckbox?.checked);
  const ready = state.currentInvoice?.customer_policy_consent?.ready === true;
  el.recordConsentBtn.disabled =
    !checked
    || !ready
    || state.consentRecordingInFlight
    || !state.invoiceId;
}

async function handleRecordInvoiceConsent() {
  if (!requireUiPermission("invoice.create", "規約同意の記録")) return;
  const invoiceId = String(state.invoiceId || "").trim();
  const consent = state.currentInvoice?.customer_policy_consent;
  if (!invoiceId || !consent?.versions || state.consentRecordingInFlight) return;
  state.consentRecordingInFlight = true;
  syncConsentControls();
  try {
    await requestJson(`/api/v1/invoices/${encodeURIComponent(invoiceId)}/policy-consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        terms_version: consent.versions.terms_version,
        privacy_version: consent.versions.privacy_version,
        refund_policy_version: consent.versions.refund_policy_version,
      }),
    });
    showToast("規約同意を記録しました。監査ログにも残っています");
    await loadInvoice(invoiceId);
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(`規約同意を記録できませんでした: ${String(error.message || error)}`, true);
    await loadInvoice(invoiceId, { silent: true });
  } finally {
    state.consentRecordingInFlight = false;
    renderInvoiceConsent();
  }
}

function stopFallbackPolling() {
  if (state.fallbackPollTimer) {
    clearInterval(state.fallbackPollTimer);
    state.fallbackPollTimer = null;
  }
  setFallbackPollingStatus("idle", "停止中");
}

function shouldObserveInvoice(invoice = state.currentInvoice) {
  const status = canonicalInvoiceStatus(invoice?.status || state.invoiceStatus);
  if (!state.invoiceId || !status || FINAL_INVOICE_STATUSES.has(status)) return false;
  return ACTIVE_INVOICE_STATUSES.has(status) || hasIntegrityHold(invoice);
}

function stopSseReconnect() {
  if (!state.sseReconnectTimer) return;
  clearTimeout(state.sseReconnectTimer);
  state.sseReconnectTimer = null;
}

function closeSse(reason = "切断") {
  stopSseReconnect();
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  setSseStatus("closed", reason);
}

function scheduleSseReconnect() {
  if (state.sseReconnectTimer || !state.invoiceId || !ACTIVE_INVOICE_STATUSES.has(state.invoiceStatus)) return;
  state.sseReconnectTimer = setTimeout(() => {
    state.sseReconnectTimer = null;
    void connectTerminalStream();
  }, 2500);
}

function startFallbackPollingIfNeeded() {
  stopFallbackPolling();
  if (!shouldObserveInvoice()) {
    setFallbackPollingStatus("idle", "対象請求なし");
    return;
  }
  state.fallbackPollTimer = setInterval(() => {
    if (!state.invoiceId) return;
    state.lastFallbackPollAt = nowIso();
    renderDiagnostics();
    void loadInvoice(state.invoiceId, { silent: true });
  }, FALLBACK_POLL_INTERVAL_MS);
  setFallbackPollingStatus("active", "SSE fallback polling");
}

function renderProviderControls(invoice) {
  if (!PROVIDER_RAIL_ENABLED) return;
  const providerSummary = invoice?.provider_summary || null;
  const canControlProvider = hasPermission("invoice.create") && state.invoiceOperationsInFlight.size === 0;
  if (hasIntegrityHold(invoice)) {
    el.providerOperatorStateText.textContent = "記録整合性を確認中";
    el.providerStatusText.textContent = "商品引渡し保留";
    el.providerControlHint.textContent = "支払い記録の整合性確認が完了するまで店頭判断を止めてください。";
    el.presentTapBtn.disabled = true;
    el.resumeQrBtn.disabled = true;
    return;
  }
  if (isFulfillmentObservationUnavailable(invoice)) {
    el.providerOperatorStateText.textContent = "最新状態を再確認中";
    el.providerStatusText.textContent = "商品引渡し保留";
    el.providerControlHint.textContent = "自動更新または最新取得が成功するまで店頭判断を止めてください。";
    el.presentTapBtn.disabled = true;
    el.resumeQrBtn.disabled = true;
    return;
  }
  if (!providerSummary?.available) {
    el.providerOperatorStateText.textContent = "QR案内";
    el.providerStatusText.textContent = "店頭端末未提示";
    el.providerControlHint.textContent = "端末入口QRを入口として案内できます。タッチ決済を使う場合だけ明示的に提示を開始します。";
    el.presentTapBtn.disabled = !canControlProvider || !state.invoiceId || invoice?.status !== "issued";
    el.resumeQrBtn.disabled = true;
    return;
  }

  el.providerOperatorStateText.textContent = providerSummary.operator_state?.label || "-";
  el.providerStatusText.textContent =
    [
      providerSummary.payment_session_status || null,
      providerSummary.provider_status || null,
      providerSummary.fulfillment_decision === "allow_fulfillment" ? "allow_fulfillment" : null,
    ].filter(Boolean).join(" / ") || "-";
  el.providerControlHint.textContent = providerSummary.qr_available
    ? "QR案内に戻っています。必要なら改めて tap を提示できます。"
    : (providerSummary.operator_state?.body || "タッチ案内中は端末入口QR導線を止め、同じ会計の二重導線を防ぎます。");
  el.presentTapBtn.disabled = !canControlProvider || providerSummary.can_present !== true;
  el.resumeQrBtn.disabled = !canControlProvider || providerSummary.can_cancel_presentation !== true;
}

function renderAmountCompare(invoice) {
  const expected = Number(invoice?.amounts?.amount_jpyc_display);
  const paid = Number(invoice?.amounts?.paid_amount_jpyc_display);
  const expectedText = invoice?.amounts?.amount_jpyc_display ?? "-";
  const paidText = invoice?.amounts?.paid_amount_jpyc_display ?? "-";
  if (el.amountCompareExpected) el.amountCompareExpected.textContent = `${formatJpycAmount(expectedText)} JPYC`;
  if (el.amountComparePaid) el.amountComparePaid.textContent = `${formatJpycAmount(paidText)} JPYC`;
  if (!el.amountCompareDelta || !el.amountComparePanel) return;
  el.amountComparePanel.classList.remove("amount-short", "amount-over", "amount-exact");
  if (!Number.isFinite(expected) || !Number.isFinite(paid)) {
    el.amountCompareDelta.textContent = "差額 -";
    return;
  }
  const delta = paid - expected;
  if (delta === 0) {
    el.amountComparePanel.classList.add("amount-exact");
    el.amountCompareDelta.textContent = "差額なし";
  } else if (delta < 0) {
    el.amountComparePanel.classList.add("amount-short");
    el.amountCompareDelta.textContent = `不足 ${formatJpycAmount(Math.abs(delta))} JPYC`;
  } else {
    el.amountComparePanel.classList.add("amount-over");
    el.amountCompareDelta.textContent = `過払い ${formatJpycAmount(delta)} JPYC`;
  }
}

function stopCompletedInvoiceAutoReset() {
  if (state.autoResetTimer) clearTimeout(state.autoResetTimer);
  state.autoResetTimer = null;
  state.autoResetInvoiceId = "";
}

function canAutoResetCompletedInvoice(invoice = state.currentInvoice) {
  const status = canonicalInvoiceStatus(invoice?.status);
  return Boolean(
    invoice?.invoice_id
    && ["paid", "settled"].includes(status)
    && !hasIntegrityHold(invoice)
    && wouldAllowFulfillment(invoice)
    && hasFreshFulfillmentObservation()
    && !state.reviewDraftDirty
    && !state.settlementCloseInFlight
    && !state.refundRequestInFlight
    && state.invoiceOperationsInFlight.size === 0
    && state.refundOperationsInFlight.size === 0
  );
}

function resetCompletedInvoiceForNextCustomer(invoiceId) {
  if (String(state.invoiceId || "") !== String(invoiceId || "") || !canAutoResetCompletedInvoice()) return false;
  const selectedReviewId = state.selectedReviewId;
  const selectedReviewDetail = state.selectedReviewDetail;
  clearInvoiceView();
  state.selectedReviewId = selectedReviewId;
  state.selectedReviewDetail = selectedReviewDetail;
  if (el.amountInput) el.amountInput.value = "";
  showToast("完了した会計表示を安全にリセットしました。次の金額を入力できます");
  window.setTimeout(() => el.amountInput?.focus(), 0);
  return true;
}

function scheduleCompletedInvoiceAutoReset(invoice = state.currentInvoice) {
  stopCompletedInvoiceAutoReset();
  if (!canAutoResetCompletedInvoice(invoice)) return;
  const settings = readTerminalSettings();
  const configuredSeconds = Number(settings.auto_reset_sec);
  if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) return;
  const delayMs = Math.min(Math.max(Math.trunc(configuredSeconds), 5), 3_600) * 1_000;
  const invoiceId = String(invoice.invoice_id || "");
  state.autoResetInvoiceId = invoiceId;
  state.autoResetTimer = window.setTimeout(() => {
    state.autoResetTimer = null;
    state.autoResetInvoiceId = "";
    if (document.visibilityState !== "visible" || !resetCompletedInvoiceForNextCustomer(invoiceId)) {
      scheduleCompletedInvoiceAutoReset(state.currentInvoice);
    }
  }, delayMs);
}

function renderInvoice(invoice) {
  const previousInvoiceId = state.invoiceId;
  const nextInvoiceId = String(invoice?.invoice_id || "");
  if (previousInvoiceId && previousInvoiceId !== nextInvoiceId) state.pendingDangerAction = "";
  state.currentInvoice = invoice;
  state.invoiceDiagnostics = invoice.diagnostics || null;
  state.invoiceConsent = invoice.customer_policy_consent || null;
  state.invoiceId = invoice.invoice_id || "";
  const invoiceStatus = canonicalInvoiceStatus(invoice.status);
  state.invoiceStatus = invoiceStatus;
  setInvoiceStatusPill(invoiceStatus);
  el.invoiceIdText.textContent = invoice.invoice_id || "-";
  if (invoice.payment_url) {
    el.paymentUrlLink.textContent = invoice.payment_url;
    el.paymentUrlLink.href = invoice.payment_url;
  } else {
    el.paymentUrlLink.textContent = "-";
    el.paymentUrlLink.removeAttribute("href");
  }
  const chainId = String(invoice?.chain?.chain_id || "");
  const selectedChain = state.paymentChains.find((chain) => String(chain.chain_id) === chainId);
  el.paymentChainText.textContent = selectedChain?.network || invoice?.wallet?.network || chainId || "-";
  el.paymentContractText.textContent = invoice?.chain?.token_contract || selectedChain?.token_contract_display || "-";
  el.expiresAtText.textContent = invoice.expires_at || "-";
  el.amountText.textContent = `${invoice.amounts?.amount_jpyc_display ?? "-"} JPYC`;
  el.paidText.textContent = `${invoice.amounts?.paid_amount_jpyc_display ?? "-"} JPYC`;
  renderAmountCompare(invoice);
  if (el.qrAccessibleText) {
    el.qrAccessibleText.textContent =
      `決済QR。請求ID ${invoice.invoice_no || invoice.invoice_id || "-"}、請求額 ${invoice.amounts?.amount_jpyc_display ?? "-"} JPYC。`;
  }
  el.reasonText.textContent = invoice.status_reason ? invoiceStatusReasonLabel(invoice.status_reason) : "-";
  renderProviderControls(invoice);
  renderCustomerFacingQr();
  renderInvoiceConsent();

  if (state.terminalId && ACTIVE_INVOICE_STATUSES.has(invoiceStatus) && (!state.sse || previousInvoiceId !== state.invoiceId)) {
    void connectTerminalStream();
  }
  if (FINAL_INVOICE_STATUSES.has(invoiceStatus)) {
    closeSse();
  }
  startFallbackPollingIfNeeded();
  renderDiagnostics();
  renderOperatorGuide();
  renderConnectionStatus();
  scheduleCompletedInvoiceAutoReset(invoice);
}

function clearInvoiceView() {
  stopCompletedInvoiceAutoReset();
  state.invoiceRequestSequence += 1;
  state.latestInvoiceRequestId = "";
  state.pendingDangerAction = "";
  state.invoiceId = "";
  state.invoiceStatus = "";
  state.currentInvoice = null;
  state.fulfillmentObservationValid = false;
  stopFulfillmentFreshnessTimer();
  state.invoiceDiagnostics = null;
  state.invoiceConsent = null;
  state.consentRecordingInFlight = false;
  state.selectedReviewId = "";
  state.selectedReviewDetail = null;
  state.sseToken = "";
  setInvoiceStatusPill("");
  el.invoiceIdText.textContent = "-";
  el.paymentUrlLink.textContent = "-";
  el.paymentUrlLink.removeAttribute("href");
  el.paymentChainText.textContent = "-";
  el.paymentContractText.textContent = "-";
  el.expiresAtText.textContent = "-";
  el.amountText.textContent = "-";
  el.paidText.textContent = "-";
  renderAmountCompare(null);
  if (el.qrAccessibleText) el.qrAccessibleText.textContent = "請求IDと金額は現在の請求欄に表示されます。";
  el.reasonText.textContent = "-";
  if (el.providerOperatorStateText) el.providerOperatorStateText.textContent = "-";
  if (el.providerStatusText) el.providerStatusText.textContent = "-";
  if (el.providerControlHint) {
    el.providerControlHint.textContent = "QR とタッチ案内は同じ会計で同時に開きません。タッチ案内中は端末入口QRからのウォレット導線を止めます。";
  }
  if (el.presentTapBtn) el.presentTapBtn.disabled = true;
  if (el.resumeQrBtn) el.resumeQrBtn.disabled = true;
  renderCustomerFacingQr();
  renderInvoiceConsent();
  closeSse("未接続");
  stopFallbackPolling();
  setFallbackPollingStatus("idle", "未開始");
  renderDiagnostics();
  renderOperatorGuide();
  renderConnectionStatus();
}

async function loadInvoice(invoiceId, options = {}) {
  const requestedInvoiceId = String(invoiceId || "").trim();
  if (!requestedInvoiceId) return { status: "skipped" };
  const requestSequence = state.invoiceRequestSequence + 1;
  state.invoiceRequestSequence = requestSequence;
  state.latestInvoiceRequestId = requestedInvoiceId;
  try {
    const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(requestedInvoiceId)}`);
    if (
      requestSequence !== state.invoiceRequestSequence
      || state.latestInvoiceRequestId !== requestedInvoiceId
    ) return { status: "stale" };
    if (String(data?.invoice_id || "") !== requestedInvoiceId) {
      throw new Error("請求IDが一致しない応答を受け取ったため破棄しました");
    }
    state.lastInvoiceRefreshAt = nowIso();
    state.fulfillmentObservationValid = true;
    renderInvoice(data);
    scheduleFulfillmentFreshnessHold();
    if (!options.silent) {
      showToast(`請求状態を更新しました（${el.invoiceStatusPill.textContent}）`);
    }
    return { status: "ok", invoice: data };
  } catch (error) {
    if (
      isIgnoredRequestError(error)
      || requestSequence !== state.invoiceRequestSequence
      || state.latestInvoiceRequestId !== requestedInvoiceId
    ) return { status: "stale" };
    failClosedFulfillmentObservation();
    if (!options.silent) showToast(String(error.message || error), true);
    return { status: "failed", error };
  }
}

function applyAmountPreset(amount) {
  el.amountInput.value = String(amount);
  el.amountInputError.textContent = "";
  showToast(`請求金額を ${formatJpy(amount)} に設定しました`);
}

function handleAddAmountPreset() {
  const amount = Number(el.presetAmountInput.value);
  if (!Number.isInteger(amount) || amount <= 0) {
    showToast("追加する金額は 1円以上の整数で入力してください", true);
    return;
  }
  const current = readTerminalSettings();
  if (current.amount_presets.includes(amount)) {
    el.amountInput.value = String(amount);
    el.amountInputError.textContent = "";
    el.presetAmountInput.value = "";
    showToast("その金額はすでにプリセットにあります");
    return;
  }
  if (current.amount_presets.length >= MAX_AMOUNT_PRESET_COUNT) {
    showToast(`プリセットは最大 ${MAX_AMOUNT_PRESET_COUNT} 件までです`, true);
    return;
  }
  writeTerminalSettings({ amount_presets: [...current.amount_presets, amount] });
  renderAmountPresetButtons();
  applyAmountPreset(amount);
  el.presetAmountInput.value = "";
}

function handleRemoveAmountPreset(amount) {
  const numericAmount = Number(amount);
  const current = readTerminalSettings();
  const nextPresets = current.amount_presets.filter((value) => value !== numericAmount);
  writeTerminalSettings({ amount_presets: nextPresets });
  renderAmountPresetButtons();
  showToast(`${formatJpy(numericAmount)} のプリセットを削除しました`);
}

function handleResetAmountPresets() {
  writeTerminalSettings({ amount_presets: [...DEFAULT_AMOUNT_PRESETS] });
  renderAmountPresetButtons();
  showToast("よく使う金額を初期セットに戻しました");
}

async function fetchSseToken(invoiceId) {
  const sessionGeneration = captureSessionGeneration();
  const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(invoiceId)}/sse-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!isSessionGenerationCurrent(sessionGeneration) || state.invoiceId !== invoiceId) {
    throw createIgnoredRequestError();
  }
  state.sseToken = data.token;
  return data.token;
}

async function connectTerminalStream() {
  if (!state.token || !state.terminalId || !state.invoiceId) return;
  closeSse();
  const sessionGeneration = captureSessionGeneration();
  const terminalId = state.terminalId;
  const invoiceId = state.invoiceId;
  let sseToken = "";
  setSseStatus("connecting", "SSE token を取得中");
  try {
    sseToken = await fetchSseToken(invoiceId);
  } catch (error) {
    if (isIgnoredRequestError(error) || !isSessionGenerationCurrent(sessionGeneration)) return;
    failClosedFulfillmentObservation();
    setNetworkStatus("再接続中（トークン取得失敗）");
    setSseStatus("reconnecting", "トークン取得失敗");
    startFallbackPollingIfNeeded();
    scheduleSseReconnect();
    return;
  }
  if (!isSessionGenerationCurrent(sessionGeneration) || state.invoiceId !== invoiceId) return;

  const streamUrl =
    `/api/v1/streams/terminals/${encodeURIComponent(terminalId)}` +
    `?invoice_id=${encodeURIComponent(invoiceId)}&sse_token=${encodeURIComponent(sseToken)}`;

  const stream = new EventSource(streamUrl);
  state.sse = stream;
  const isCurrentStream = () =>
    isSessionGenerationCurrent(sessionGeneration) && state.invoiceId === invoiceId && state.sse === stream;

  stream.addEventListener("open", () => {
    if (!isCurrentStream()) {
      stream.close();
      return;
    }
    setNetworkStatus("リアルタイム接続中");
    setSseStatus("open", "SSE 接続済み");
    state.lastStreamEventAt = nowIso();
    void loadInvoice(invoiceId, { silent: true });
    startFallbackPollingIfNeeded();
  });

  const refreshFromStream = (event) => {
    if (!isCurrentStream()) {
      stream.close();
      return;
    }
    try {
      const payload = JSON.parse(event.data || "{}");
      const updatedInvoiceId = payload.invoiceId || payload.invoice_id;
      if (!updatedInvoiceId) return;
      state.lastStreamEventAt = nowIso();
      renderDiagnostics();
      if (state.invoiceId === updatedInvoiceId) {
        failClosedFulfillmentObservation();
        void loadInvoice(updatedInvoiceId, { silent: true });
      }
    } catch (_error) {
      // no-op
    }
  };

  stream.addEventListener("snapshot", refreshFromStream);
  stream.addEventListener("invoice.updated", refreshFromStream);
  stream.addEventListener("status_changed", refreshFromStream);
  stream.addEventListener("heartbeat", () => {
    if (!isCurrentStream()) {
      stream.close();
      return;
    }
    setNetworkStatus("リアルタイム接続中");
    setSseStatus("open", "heartbeat");
    state.lastStreamEventAt = nowIso();
    renderDiagnostics();
  });
  stream.addEventListener("error", () => {
    if (!isCurrentStream()) {
      stream.close();
      return;
    }
    failClosedFulfillmentObservation();
    setNetworkStatus("再接続中（自動更新中）");
    setSseStatus("reconnecting", "自動再接続待ち");
    startFallbackPollingIfNeeded();
    scheduleSseReconnect();
  });
}

function formatRole(role) {
  const labels = {
    admin: "管理者",
    manager: "マネージャー",
    accounting: "経理担当",
    operator: "オペレーター",
    staff: "スタッフ",
  };
  return labels[role] || role || "-";
}

function applyPermissionVisibility() {
  mountStorePaymentsControl();
  mountAdminOperations();
  refreshDynamicElementRefs();
  for (const node of el.permissionNodes) {
    const requiredPermission = String(node.dataset.permission || "").trim();
    const anyPermissions = String(node.dataset.permissionAny || "").trim().split(/\s+/).filter(Boolean);
    const visible = Boolean(
      state.token &&
      state.permissionsKnown &&
      (requiredPermission ? hasPermission(requiredPermission) : hasAnyPermission(anyPermissions))
    );
    node.classList.toggle("hidden", !visible);
    node.setAttribute("aria-hidden", visible ? "false" : "true");
    if ("disabled" in node) node.disabled = !visible;
  }
  renderStorePaymentsControl();
  syncInvoiceOperationControls();
  updateRefundStepState();
}

function setReviewListState(kind, message) {
  if (!el.reviewListState) return;
  el.reviewListState.className = `${kind}-state`;
  el.reviewListState.textContent = message;
}

function reviewStatusLabel(status) {
  const map = {
    open: "未対応",
    in_progress: "対応中",
    resolved: "解決済み",
    rejected: "却下",
  };
  return map[status] || status || "-";
}

function reviewReasonLabel(reason) {
  const code = normalizeReviewReason(reason);
  const map = {
    UNDERPAYMENT: "金額不足",
    OVERPAYMENT: "金額が多く支払われています",
    DUPLICATE_PAYMENT: "追加支払い(重複)が届きました",
    SPLIT_PAYMENT: "分割支払いが届いています",
    LATE_PAYMENT: "期限後に支払いが届きました",
    CHAIN_INCONSISTENT: "チェーン不一致",
    UNKNOWN_TRANSFER: "送金条件不一致",
    ADDRESS_MISMATCH: "送金先不一致",
    CHAIN_REORG: "チェーン再編成による再確認",
    LEDGER_INTEGRITY_ERROR: "会計台帳の整合性確認が必要",
    CHAIN_TRANSFER_IDENTITY_INCOMPLETE: "送金識別情報が不足しています",
    TIMESTAMP_UNVERIFIED: "ブロック時刻を検証できません",
    DETECTED_AFTER_EXPIRY: "期限後に検知されました",
    CROSS_INVOICE_TRANSFER_COLLISION: "同じ送金が複数請求に関連しています",
    OTHER: "確認が必要な支払い",
  };
  return map[code] || map.OTHER;
}

function invoiceStatusReasonLabel(reason) {
  const code = normalizeReviewReason(reason);
  const map = {
    PAID_EXACT: "請求額どおりの支払いを確認しました",
    PAYMENT_DETECTED: "支払いを検知し、確認を続けています",
    CONFIRMING: "支払いの確認を続けています",
    DAILY_SETTLEMENT_CLOSED: "日次締めへ反映しました",
    REVIEW_REQUIRED: "店舗で支払い内容の確認が必要です",
    CANCELLED: "この請求は無効です",
    EXPIRED: "この請求は期限切れです",
    UNDERPAYMENT: "請求額に不足があります",
    OVERPAYMENT: "請求額より多い支払いを確認しました",
    DUPLICATE_PAYMENT: "追加の支払いを確認しました",
    SPLIT_PAYMENT: "複数回に分かれた支払いを確認しました",
    LATE_PAYMENT: "期限後の支払いを確認しました",
    CHAIN_INCONSISTENT: "支払いネットワークの確認が必要です",
    UNKNOWN_TRANSFER: "支払い条件の確認が必要です",
    ADDRESS_MISMATCH: "支払い先の確認が必要です",
    CHAIN_REORG: "支払い記録を再確認しています",
    LEDGER_INTEGRITY_ERROR: "会計記録の整合性確認が必要です",
    OTHER: "状態詳細は運用ログで確認してください",
  };
  return map[code] || map.OTHER;
}

function refundStatusLabel(status) {
  const map = {
    requested: "申請済み・承認待ち",
    approved: "承認済み・外部返金待ち",
    recorded: "返金記録済み・検証待ち",
    pending_verification: "返金記録を検証中",
    verification_failed: "返金記録を確認できませんでした",
    failed: "返金処理の確認が必要です",
    succeeded: "返金を検証済み",
    finalized: "返金記録を確定済み",
    rejected: "返金申請を却下済み",
    cancelled: "返金申請を取り消し済み",
  };
  return map[String(status || "").trim()] || "返金状態は運用ログで確認してください";
}

function captureReviewDraft() {
  return {
    next_status: String(el.reviewNextStatus?.value || ""),
    disposition: String(el.reviewDisposition?.value || ""),
    incident_id: String(el.reviewIncidentId?.value || ""),
    note: String(el.reviewNote?.value || ""),
    adjustment_id: String(el.reviewAdjustmentId?.value || ""),
    adjustment_type: String(el.reviewAdjustmentType?.value || ""),
    adjustment_amount: String(el.reviewAdjustmentAmount?.value || ""),
    adjustment_reason: String(el.reviewAdjustmentReason?.value || ""),
    adjustment_evidence_ref: String(el.reviewAdjustmentEvidenceRef?.value || ""),
  };
}

function saveBoundReviewDraft() {
  const reviewId = String(state.reviewDraftBindingId || "").trim();
  if (!reviewId || !state.reviewDraftDirty) return;
  state.reviewDrafts.set(reviewId, captureReviewDraft());
}

function restoreReviewDraft(reviewId) {
  const normalizedReviewId = String(reviewId || "").trim();
  const draft = state.reviewDrafts.get(normalizedReviewId);
  state.reviewDraftBindingId = normalizedReviewId;
  state.reviewDraftDirty = false;
  if (!draft) return false;
  el.reviewNextStatus.value = draft.next_status || el.reviewNextStatus.value;
  el.reviewDisposition.value = draft.disposition || "";
  el.reviewIncidentId.value = draft.incident_id || "";
  el.reviewNote.value = draft.note || "";
  el.reviewAdjustmentId.value = draft.adjustment_id || "";
  el.reviewAdjustmentType.value = draft.adjustment_type || el.reviewAdjustmentType.value;
  el.reviewAdjustmentAmount.value = draft.adjustment_amount || "";
  el.reviewAdjustmentReason.value = draft.adjustment_reason || "";
  el.reviewAdjustmentEvidenceRef.value = draft.adjustment_evidence_ref || "";
  if (el.reviewUpdateImpact) {
    el.reviewUpdateImpact.textContent = `レビュー ${shortId(normalizedReviewId)} の編集中下書きを復元しました。別レビューの下書きとは混在しません。`;
  }
  return true;
}

function markReviewDraftDirty() {
  if (!state.reviewDraftBindingId) return;
  state.reviewDraftDirty = true;
  state.pendingReviewUpdate = "";
  if (el.updateReviewBtn) el.updateReviewBtn.textContent = "レビューを更新";
  if (el.reviewUpdateImpact) {
    el.reviewUpdateImpact.textContent = `レビュー ${shortId(state.reviewDraftBindingId)} の下書きを編集中です。切替後もレビューID別に保持します。`;
  }
}

function renderReviewSummary(rows) {
  if (!el.reviewSummaryChips) return;
  const counts = { open: 0, in_progress: 0, resolved: 0, rejected: 0 };
  let highestPriorityCount = 0;
  let refundCandidateCount = 0;
  for (const row of rows) {
    const key = String(row.status || "");
    if (Object.prototype.hasOwnProperty.call(counts, key)) {
      counts[key] += 1;
    }
    if (reviewPriorityMeta(row).label === "最優先") {
      highestPriorityCount += 1;
    }
    if (["open", "in_progress"].includes(key) && isRefundCandidateReason(row.reason_type)) {
      refundCandidateCount += 1;
    }
  }

  el.reviewSummaryChips.innerHTML = "";
  const chips = [
    { label: `最優先 ${highestPriorityCount}件`, className: "status-pill s-red" },
    { label: `返金候補 ${refundCandidateCount}件`, className: "status-pill s-blue" },
    { label: `未対応 ${counts.open}件`, className: "status-pill s-yellow" },
    { label: `対応中 ${counts.in_progress}件`, className: "status-pill s-blue" },
    { label: `解決済み ${counts.resolved}件`, className: "status-pill s-green" },
    { label: `却下 ${counts.rejected}件`, className: "status-pill s-red" },
  ];
  for (const chipConfig of chips) {
    const chip = document.createElement("span");
    chip.className = chipConfig.className;
    chip.textContent = chipConfig.label;
    el.reviewSummaryChips.appendChild(chip);
  }
}

function applyRefundDraftFromReview(review, suggestion, events) {
  const hintParts = [];
  el.refundReviewCaseId.value = review.id || "";
  hintParts.push(`レビューID ${shortId(review.id, 10, 5)}`);

  if (suggestion.suggestedRefundAmount != null) {
    el.refundAmount.value = String(suggestion.suggestedRefundAmount);
    hintParts.push(`返金候補 ${formatJpyc(suggestion.suggestedRefundAmount)}`);
    el.refundEligibleHint.textContent = `レビューから算出した返金候補: ${formatJpyc(suggestion.suggestedRefundAmount)}。申請時はサーバーが返金可能上限を再検証します。`;
  } else {
    el.refundAmount.value = "";
    hintParts.push("返金候補額なし");
    el.refundEligibleHint.textContent = "このレビューには自動算出できる返金候補額がありません。明細を確認して入力してください。";
  }

  const chainCandidate = String(
    review?.chain_id ||
      events.find((event) => event?.chain_id)?.chain_id ||
      ""
  ).trim();
  if (chainCandidate) {
    el.refundChainId.value = chainCandidate;
    hintParts.push(`チェーン ${chainCandidate}`);
  } else {
    el.refundChainId.value = "";
    hintParts.push("チェーン要確認");
  }

  const payerAddresses = [...new Set(events
    .map((event) => String(event?.from_address || "").trim().toLowerCase())
    .filter((value) => isLikelyEvmAddress(value)))];
  const fromAddressCandidate = payerAddresses.length === 1 ? payerAddresses[0] : "";
  state.refundPayerAddressVerified = Boolean(fromAddressCandidate);
  state.refundPayerAddressReviewId = fromAddressCandidate ? String(review.id || "") : "";
  el.refundAddress.readOnly = true;
  if (fromAddressCandidate) {
    el.refundAddress.value = fromAddressCandidate;
    hintParts.push("返金先を一意に確認した支払い元へ固定");
    el.refundAddressPolicyHint.textContent = "返金先は、選択レビューで一意に確認した支払い元アドレスに固定しています。代替返金先はこの端末では受け付けません。";
  } else {
    el.refundAddress.value = "";
    hintParts.push(payerAddresses.length > 1 ? "支払い元が複数あり管理者確認が必要" : "支払い元を確認できません");
    el.refundAddressPolicyHint.textContent = payerAddresses.length > 1
      ? "複数の支払い元アドレスが見つかったため返金申請を停止しました。取引証跡を管理者が確認してください。"
      : "支払い元アドレスを確認できないため返金申請を停止しました。代替返金先の手入力は受け付けません。";
  }

  el.refundDraftHint.textContent =
    hintParts.length > 0
      ? `返金フォーム下書き: ${hintParts.join(" / ")}`
      : "返金申請を停止しています。支払い元を一意に確認できない場合は管理者へ引き継ぎ、別の署名チャレンジ完了済みフローで確認してください。";
  handleRefundDraftChanged();
}

function renderReviewDetail(detail = null) {
  if (!el.reviewDetailBadge) return;
  state.selectedReviewDetail = detail;
  const review = detail?.review || null;
  const events = Array.isArray(detail?.events) ? detail.events : [];

  if (!review) {
    state.reviewDraftBindingId = "";
    state.reviewDraftDirty = false;
    el.reviewDetailBadge.textContent = "未選択";
    el.reviewDetailBadge.className = "status-pill s-gray";
    el.reviewDetailSummary.textContent =
      "一覧から確認待ち支払いを選ぶと、原因・対象請求・直近イベント・返金候補をここで確認できます。";
    el.reviewDetailId.textContent = "-";
    el.reviewDetailInvoice.textContent = "-";
    el.reviewDetailAmount.textContent = "-";
    el.reviewDetailTxHash.textContent = "-";
    el.reviewDetailAction.textContent = "ここには、そのレビューでまず何を確認するかと、推奨ステータスを表示します。";
    el.reviewDetailRefundHint.textContent =
      "返金が必要そうな場合は、候補額をここに表示し、下の返金記録フォームにも下書きします。";
    el.reviewDetailEvents.textContent = "レビューを選ぶと、その支払いに紐づく直近イベントをここへ表示します。";
    el.reviewRelatedInvoices.textContent = "レビューを選ぶと、同じ会計で再発行された関連請求をここへ表示します。";
    el.reviewAdjustmentInvoiceId.value = "";
    el.accountingAdjustmentStatus.textContent = "レビューを選択すると対象請求を表示します。";
    el.refundDraftHint.textContent =
      "レビューを選択すると、返金候補額・支払い元アドレス・チェーンIDを返金フォームへ下書きします。";
    el.refundEligibleHint.textContent = "レビューを選択すると、サーバーが返した返金可能額を表示します。";
    state.refundPayerAddressVerified = false;
    state.refundPayerAddressReviewId = "";
    if (el.refundAddress) el.refundAddress.value = "";
    return;
  }

  const suggestion = computeReviewSuggestion(review);
  const relatedInvoices = Array.isArray(detail?.related_invoices) ? detail.related_invoices : [];
  const priority = reviewPriorityMeta(review);
  const ageMinutes = reviewAgeMinutes(review);
  const nextStatusLabel = reviewStatusLabel(suggestion.suggestedNextStatus || review.status);
  el.reviewDetailBadge.textContent = `${reviewStatusLabel(review.status)} / ${priority.label}`;
  el.reviewDetailBadge.className = `status-pill ${review.status === "resolved" ? "s-green" : review.status === "rejected" ? "s-red" : priority.className}`;
  el.reviewDetailSummary.textContent =
    `${reviewReasonLabel(review.reason_type)} / ${formatJpy(review.amount_jpy)} / 請求状態 ${reviewStatusLabel(review.invoice_status || review.status)} / 経過 ${ageMinutes}分`;
  el.reviewDetailId.textContent = review.id || "-";
  el.reviewDetailInvoice.textContent = review.invoice_no || review.invoice_id || "-";
  el.reviewAdjustmentInvoiceId.value = review.invoice_id || "";
  el.accountingAdjustmentStatus.textContent = `対象請求 ${review.invoice_id || "-"}。支払い状態は会計調整では変更されません。`;
  el.reviewDetailAmount.textContent = `${formatJpy(review.amount_jpy)} / 受取 ${formatJpyc(review.paid_amount_jpyc)}`;
  el.reviewDetailTxHash.textContent = review.paid_tx_hash || "-";
  el.reviewDetailAction.textContent = `${suggestion.action}（推奨ステータス: ${nextStatusLabel}）`;
  el.reviewDetailRefundHint.textContent = `${suggestion.refundHint} / 優先度: ${suggestion.priorityLabel}`;
  el.reviewDetailEvents.textContent =
    events.length > 0
      ? events
          .slice(0, 5)
          .map((event) => {
            const parts = [
              event.event_type || "event",
              event.amount_jpyc != null ? `${event.amount_jpyc} JPYC` : null,
              event.chain_id ? `chain ${event.chain_id}` : null,
              event.from_address ? `from ${event.from_address}` : null,
              event.tx_hash || null,
              formatDateTime(event.created_at),
            ].filter(Boolean);
            return `- ${parts.join(" | ")}`;
          })
          .join("\n")
      : "イベントはありません。";
  if (normalizeReviewReason(review.reason_type) === "LATE_PAYMENT") {
    el.reviewRelatedInvoices.textContent =
      relatedInvoices.length > 0
        ? [
            "同じ会計で再発行された請求があります。",
            "新しい請求がすでに支払い確認済みの場合、旧請求への着金は二重支払いの可能性があります。",
            ...relatedInvoices.map((invoice) => {
              const parts = [
                invoice.relation || "related",
                invoice.invoice_no || invoice.invoice_id || "-",
                `状態 ${invoice.status || "-"}`,
                invoice.amount_jpyc != null ? `請求 ${invoice.amount_jpyc} JPYC` : null,
                invoice.paid_amount_jpyc != null ? `受取 ${invoice.paid_amount_jpyc} JPYC` : null,
                invoice.paid_at ? `確認 ${formatDateTime(invoice.paid_at)}` : null,
                invoice.primary_tx_hash ? `tx ${invoice.primary_tx_hash}` : null,
              ].filter(Boolean);
              return `- ${parts.join(" | ")}`;
            }),
          ].join("\n")
        : "同じ会計の再発行請求は見つかりませんでした。";
  } else {
    el.reviewRelatedInvoices.textContent = "期限後入金の確認時に、同じ会計の関連請求を表示します。";
  }

  const incidents = Array.isArray(review.incidents) ? review.incidents : [];
  const openIncident = incidents.find((incident) => ["open", "in_progress"].includes(String(incident.status || "")));
  el.reviewIncidentId.value = openIncident?.id || "";
  el.reviewDisposition.value = String(review.disposition || "");
  applyRefundDraftFromReview(review, suggestion, events);
  el.reviewNextStatus.value = suggestion.suggestedNextStatus || review.status;
  restoreReviewDraft(review.id);
}

function highlightSelectedReviewRow() {
  const rows = Array.from(el.reviewsTableBody.querySelectorAll("tr"));
  for (const row of rows) {
    const selected = row.dataset.reviewId === state.selectedReviewId;
    row.classList.toggle("is-selected", selected);
    row.setAttribute("aria-selected", selected ? "true" : "false");
  }
}

async function selectReview(reviewId) {
  const nextId = String(reviewId || "").trim();
  if (!nextId || !hasPermission("review.read")) return;
  if (state.reviewDraftBindingId && state.reviewDraftBindingId !== nextId) saveBoundReviewDraft();
  if (el.reviewStepUpPin) el.reviewStepUpPin.value = "";
  state.pendingReviewUpdate = "";
  if (el.updateReviewBtn) el.updateReviewBtn.textContent = "レビューを更新";
  const requestSequence = state.reviewDetailSequence + 1;
  state.reviewDetailSequence = requestSequence;
  state.reviewDetailRequestId = nextId;
  state.selectedReviewId = nextId;
  highlightSelectedReviewRow();
  el.reviewIdInput.value = nextId;
  try {
    const data = await requestJson(`/api/v1/reviews/${encodeURIComponent(nextId)}`);
    if (
      requestSequence !== state.reviewDetailSequence
      || state.reviewDetailRequestId !== nextId
      || state.selectedReviewId !== nextId
    ) return { status: "stale" };
    if (String(data?.review?.id || "") !== nextId) throw new Error("レビューIDが一致しない応答を破棄しました");
    renderReviewDetail(data);
    return { status: "ok", detail: data };
  } catch (error) {
    if (
      isIgnoredRequestError(error)
      || requestSequence !== state.reviewDetailSequence
      || state.reviewDetailRequestId !== nextId
      || state.selectedReviewId !== nextId
    ) return { status: "stale" };
    renderReviewDetail(null);
    showToast(String(error.message || error), true);
    return { status: "failed", error };
  }
}

function createReviewRow(row) {
  const tr = document.createElement("tr");
  tr.className = "clickable-row";
  tr.dataset.reviewId = row.id;
  tr.tabIndex = 0;
  tr.setAttribute("aria-selected", "false");
  tr.setAttribute("aria-label", `レビュー ${shortId(row.id)}、${reviewReasonLabel(row.reason_type)}、${reviewStatusLabel(row.status)}。Enter または Space で詳細を表示`);
  const priority = reviewPriorityMeta(row);

  const cells = [
    { className: "mono", text: row.id },
    { badge: priority },
    { className: "mono", text: row.invoice_no || row.invoice_id || "-" },
    { text: reviewReasonLabel(row.reason_type) },
    { text: reviewStatusLabel(row.status) },
  ];

  for (const cell of cells) {
    const td = document.createElement("td");
    if (cell.className) td.className = cell.className;
    if (cell.badge) {
      const badge = document.createElement("span");
      badge.className = `status-pill ${cell.badge.className}`;
      badge.textContent = cell.badge.label;
      td.appendChild(badge);
    } else {
      td.textContent = cell.text || "-";
    }
    tr.appendChild(td);
  }

  const activate = () => {
    void selectReview(row.id);
  };
  tr.addEventListener("click", activate);
  tr.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
  return tr;
}

async function handleLogin() {
  if (state.logoutRetryToken) {
    showToast("ログアウト完了を確認するまで、新しい担当者ではログインできません", true);
    return;
  }
  const terminalCode = String(el.terminalCode.value || "").trim();
  const staffName = String(el.staffName.value || "").trim();
  const staffPin = String(el.staffPin.value || "").trim();
  clearLoginError();
  if (!terminalCode) {
    showLoginError("端末コードを入力してください。", el.terminalCode);
    return;
  }
  if (!staffName) {
    showLoginError("スタッフ名を入力してください。", el.staffName);
    return;
  }
  if (!/^\d{4,8}$/.test(staffPin)) {
    showLoginError("スタッフPINは4〜8桁の数字で入力してください。", el.staffPin);
    return;
  }

  el.loginBtn.disabled = true;
  const loginEpoch = state.sessionEpoch;
  try {
    const data = await requestJson("/api/v1/terminal-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalCode, staffPin, staffName }),
    });
    if (loginEpoch !== state.sessionEpoch || state.logoutRetryToken) return;
    advanceSessionEpoch();
    state.token = data.token;
    state.terminalId = data.terminalId || data.terminal_id || "";
    state.storeId = data.storeId || data.store_id || "";
    state.sessionId = data.sessionId || data.session_id || "";
    state.role = String(data.role || "staff");
    state.staffName = String(data.staff_name || data.staffName || staffName);
    state.staffCode = String(data.staff_code || data.staffCode || "");
    const permissions = Array.isArray(data.effective_permissions)
      ? data.effective_permissions
      : Array.isArray(data.permissions)
        ? data.permissions
        : [];
    state.permissionsKnown = Array.isArray(data.effective_permissions) || Array.isArray(data.permissions);
    state.effectivePermissions = new Set(permissions.map((permission) => String(permission || "").trim()).filter(Boolean));
    state.storeTimezone = safeTimeZone(data.store_timezone || data.storeTimezone || data.timezone || "Asia/Tokyo");
    const explicitExpiry = data.session_expires_at || data.sessionExpiresAt || data.expires_at || "";
    const startedAtMs = new Date(data.started_at || Date.now()).getTime();
    const ttlMs = Number(data.session_ttl_sec) * 1000;
    state.sessionExpiresAt = explicitExpiry || (Number.isFinite(startedAtMs) && Number.isFinite(ttlMs)
      ? new Date(startedAtMs + ttlMs).toISOString()
      : "");
    state.diagnosticsEnabled = data.diagnostic_mode_enabled === true;
    state.deploymentTopology = String(data.deployment_topology || "public_cloud");
    state.supportedWallets = Array.isArray(data.supported_wallets) ? data.supported_wallets : [];
    state.policyOrigin = typeof data.public_policy_origin === "string" ? data.public_policy_origin.trim() : "";
    state.policyLinks = data.public_policy_links && typeof data.public_policy_links === "object"
      ? data.public_policy_links
      : null;
    setPaymentsDisableState(
      data.payments,
      normalizePaymentsDisableState(data.payments) ? "ready" : "error"
    );
    state.fixedQrUrl = typeof data.fixed_qr_url === "string" ? data.fixed_qr_url : "";
    state.fixedQrToken = typeof data.public_entry_token === "string" ? data.public_entry_token : "";
    el.staffPin.value = "";
    clearLoginError();
    const authenticatedGeneration = captureSessionGeneration();

    setLoggedInUi(true);
    loadTerminalSettings();
    el.sessionIdentityText.textContent = state.staffCode ? `${state.staffName}（${state.staffCode}）` : state.staffName;
    el.sessionRoleText.textContent = formatRole(state.role);
    el.sessionText.textContent = state.sessionId;
    el.sessionPermissionText.textContent = state.permissionsKnown
      ? `実効権限 ${state.effectivePermissions.size}件（許可された操作のみ表示）`
      : "実効権限を確認できないため、管理・返金・締め・監査・監視操作を非表示にしています。";
    if (el.businessTimezoneText) {
      el.businessTimezoneText.textContent = state.storeTimezone;
      el.businessDateInput.value = nowIsoDate();
      el.businessMonthInput.value = nowIsoDate().slice(0, 7);
    }
    startSessionExpiryTimer();
    setNetworkStatus("認証済み");
    renderCustomerFacingQr();
    renderSitesGuide();
    applyPermissionVisibility();
    renderDiagnostics();
    renderOperatorGuide();
    if (hasAnyPermission(["invoice.create", "invoice.read"])) {
      await loadPaymentChains();
      if (!isSessionGenerationCurrent(authenticatedGeneration)) return;
    }
    if (data.current_invoice?.invoice_id) {
      await loadInvoice(data.current_invoice.invoice_id, { silent: true });
      if (!isSessionGenerationCurrent(authenticatedGeneration)) return;
    } else {
      clearInvoiceView();
    }
    if (hasAnyPermission(["review.read", "settlement.close", "monitor.read"])) {
      await loadOpsSnapshot();
      if (!isSessionGenerationCurrent(authenticatedGeneration)) return;
      startOpsAutoRefresh();
    }
    if (hasPermission("review.read")) void loadReviews();
    else setReviewListState("empty", "確認待ち一覧は現在の実効権限の対象外です。");
    if (hasPermission("accounting.adjustment.read")) {
      await loadPendingAccountingAdjustments();
      if (!isSessionGenerationCurrent(authenticatedGeneration)) return;
    }
    if (hasPermission("settlement.export")) {
      void handleReloadSettlementExport();
    }
    if (hasPermission("monitor.read")) {
      await loadOpsWarnings();
      if (!isSessionGenerationCurrent(authenticatedGeneration)) return;
    }
    else renderOpsWarningsList(["監視状態は現在の実効権限の対象外です"]);
    showToast("ログインしました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showLoginError(loginErrorMessage(error), error?.code === "VALIDATION_ERROR" ? el.staffPin : el.loginError);
  } finally {
    el.loginBtn.disabled = Boolean(state.logoutRetryToken);
  }
}

function renderPaymentChains(chains = []) {
  const previous = String(el.paymentChainSelect?.value || "");
  state.paymentChains = Array.isArray(chains) ? chains : [];
  if (!el.paymentChainSelect) return;
  el.paymentChainSelect.replaceChildren();
  for (const chain of state.paymentChains) {
    const option = document.createElement("option");
    option.value = String(chain.chain_id || "");
    option.textContent = `${chain.short_name || chain.network || chain.chain_id}（Chain ID ${chain.chain_id}）`;
    el.paymentChainSelect.appendChild(option);
  }
  const nextValue = state.paymentChains.some((chain) => String(chain.chain_id) === previous)
    ? previous
    : String(state.paymentChains[0]?.chain_id || "");
  el.paymentChainSelect.value = nextValue;
  el.paymentChainSelect.disabled = state.paymentChains.length === 0 || !hasPermission("invoice.create");
  const selected = state.paymentChains.find((chain) => String(chain.chain_id) === nextValue);
  el.paymentChainHint.textContent = selected
    ? `${selected.network} / 公式JPYC ${selected.token_contract_display || selected.token_contract}`
    : "利用可能な支払いチェーンを取得できません。請求作成を停止しています。";
  syncInvoiceOperationControls();
}

async function loadPaymentChains() {
  try {
    const data = await requestJson("/api/v1/payment-chains");
    renderPaymentChains(data.payment_chains || []);
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    renderPaymentChains([]);
    showToast("支払いチェーンを確認できないため請求作成を停止しました", true);
  }
}

function enterLogoutRetryState(token, logoutIdempotencyKey, reason) {
  resetSessionUi(reason, {
    logoutRetryToken: token,
    logoutIdempotencyKey,
  });
}

async function handleLogout() {
  if (state.logoutInFlight) return;
  const logoutToken = state.logoutRetryToken || state.token;
  if (!logoutToken) {
    resetSessionUi("未ログイン");
    return;
  }
  const logoutIdempotencyKey = state.logoutIdempotencyKey || idempotencyKey("terminal-logout");
  state.logoutIdempotencyKey = logoutIdempotencyKey;
  state.logoutInFlight = true;
  el.logoutBtn.disabled = true;
  try {
    await requestJson("/api/v1/terminal-sessions/current", {
      method: "DELETE",
      headers: { "idempotency-key": logoutIdempotencyKey },
    }, {
      authToken: logoutToken,
      bindToSession: false,
      resetOn401: false,
    });
    resetSessionUi("担当者交代待ち");
    showToast("ログアウトしました。次の担当者でログインしてください");
  } catch (error) {
    if (error.status === 401) {
      resetSessionUi("担当者交代待ち");
      showToast("サーバー側のセッションは終了済みです。次の担当者でログインしてください");
      return;
    }
    enterLogoutRetryState(
      logoutToken,
      logoutIdempotencyKey,
      "ログアウト完了を確認できません。通信復旧後に同じボタンで再試行してください"
    );
    showToast("ログアウト完了を確認できません。機密情報を隠し、再試行だけを許可しています", true);
  } finally {
    state.logoutInFlight = false;
    if (state.logoutRetryToken) el.logoutBtn.disabled = false;
  }
}

async function handleCreateInvoice() {
  if (!requireUiPermission("invoice.create", "請求作成")) return;
  if (!paymentIssuanceAllowed()) {
    renderStorePaymentsControl();
    showToast(
      state.paymentsDisableState?.disabled
        ? "店舗・端末・全体のいずれかで決済が停止中です"
        : "決済停止状態を確認できないため、新規請求は作成できません",
      true
    );
    return;
  }
  const amount = Number(el.amountInput.value);
  const paymentChainId = String(el.paymentChainSelect?.value || "").trim();
  if (!Number.isInteger(amount) || amount <= 0) {
    el.amountInputError.textContent = "金額は1円以上の整数で入力してください。";
    return;
  }
  if (!paymentChainId) {
    el.amountInputError.textContent = "支払いチェーンを選択してください。";
    return;
  }
  const operation = beginInvoiceOperation("invoice-create", `${amount}:${paymentChainId}`, { stable: false });
  if (!operation) return;
  el.amountInputError.textContent = "";
  el.createInvoiceBtn.disabled = true;
  el.createInvoiceBtn.classList.add("loading");
  try {
    const data = await requestJson("/api/v1/invoices", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operation.idempotencyKey,
      },
      body: JSON.stringify({ amount_jpy: amount, payment_chain_id: paymentChainId }),
    });
    showToast("請求を作成しました");
    await loadInvoice(data.invoice_id);
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    if (error?.payload?.error?.code === "TERMINAL_ACTIVE_INVOICE_EXISTS") {
      const activeInvoice = error.payload?.error?.details?.active_invoice;
      if (activeInvoice?.invoice_id) {
        try {
          await loadInvoice(activeInvoice.invoice_id, { silent: true });
        } catch (_innerError) {
          // no-op
        }
      }
      showToast("現在の会計が残っています。再発行または取消/期限切れ処理後に新規会計を開始してください。", true);
    } else {
      showToast(String(error.message || error), true);
    }
  } finally {
    el.createInvoiceBtn.classList.remove("loading");
    endInvoiceOperation(operation);
  }
}

async function postInvoiceAction(actionPath, actionLabel, invoiceId = state.invoiceId) {
  if (!requireUiPermission("invoice.create", actionLabel)) return;
  const targetInvoiceId = String(invoiceId || "").trim();
  if (!targetInvoiceId) {
    showToast("対象の請求がありません", true);
    return;
  }
  const operation = beginInvoiceOperation(`invoice-${actionPath}`, targetInvoiceId);
  if (!operation) return;
  try {
    await requestJson(`/api/v1/invoices/${encodeURIComponent(targetInvoiceId)}/${actionPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operation.idempotencyKey,
      },
      body: "{}",
    });
    showToast(actionLabel);
    await loadInvoice(targetInvoiceId, { silent: true });
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  } finally {
    endInvoiceOperation(operation);
  }
}

async function handleReissueInvoice() {
  if (!requireUiPermission("invoice.create", "QR再発行")) return;
  if (!paymentIssuanceAllowed()) {
    showToast("決済停止状態が有効または未確認のため、QRを再発行できません", true);
    return;
  }
  const targetInvoiceId = String(state.invoiceId || "").trim();
  if (!targetInvoiceId) {
    showToast("再発行対象の請求がありません", true);
    return;
  }
  const operation = beginInvoiceOperation("invoice-reissue", targetInvoiceId);
  if (!operation) return;
  el.reissueInvoiceBtn.disabled = true;
  try {
    const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(targetInvoiceId)}/reissue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operation.idempotencyKey,
      },
      body: "{}",
    });
    showToast("QRを再発行しました");
    await loadInvoice(data.invoice_id, { silent: true });
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  } finally {
    endInvoiceOperation(operation);
  }
}

async function handlePresentTap() {
  if (!PROVIDER_RAIL_ENABLED || !el.presentTapBtn) return;
  if (!requireUiPermission("invoice.create", "タッチ決済の提示")) return;
  const targetInvoiceId = String(state.invoiceId || "").trim();
  if (!targetInvoiceId) {
    showToast("tap 提示対象の請求がありません", true);
    return;
  }
  const operation = beginInvoiceOperation("provider-present", targetInvoiceId);
  if (!operation) return;
  el.presentTapBtn.disabled = true;
  try {
    const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(targetInvoiceId)}/provider-sessions:present`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operation.idempotencyKey,
      },
      body: "{}",
    });
    if (data.duplicate) {
      showToast("すでにタッチ決済を提示中です");
    } else {
      showToast("タッチ決済を提示しました");
    }
    await loadInvoice(data.invoice_id || targetInvoiceId, { silent: true });
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  } finally {
    endInvoiceOperation(operation);
    if (state.currentInvoice) {
      renderProviderControls(state.currentInvoice);
    } else {
      el.presentTapBtn.disabled = false;
    }
  }
}

async function handleResumeQr() {
  if (!PROVIDER_RAIL_ENABLED || !el.resumeQrBtn) return;
  if (!requireUiPermission("invoice.create", "QR案内へ戻す操作")) return;
  const targetInvoiceId = String(state.invoiceId || "").trim();
  if (!targetInvoiceId) {
    showToast("QRへ戻す対象の請求がありません", true);
    return;
  }
  const operation = beginInvoiceOperation("provider-cancel", targetInvoiceId);
  if (!operation) return;
  el.resumeQrBtn.disabled = true;
  try {
    const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(targetInvoiceId)}/provider-sessions:cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operation.idempotencyKey,
      },
      body: "{}",
    });
    showToast("QR案内へ戻しました");
    await loadInvoice(data.invoice_id || targetInvoiceId, { silent: true });
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  } finally {
    endInvoiceOperation(operation);
    if (state.currentInvoice) {
      renderProviderControls(state.currentInvoice);
    } else {
      el.resumeQrBtn.disabled = false;
    }
  }
}

async function loadReviews() {
  if (!hasPermission("review.read") || !el.reviewStatusFilter || !el.reviewsTableBody) return;
  const requestSequence = state.reviewListSequence + 1;
  state.reviewListSequence = requestSequence;
  const status = String(el.reviewStatusFilter.value || "");
  state.reviewListFilter = status;
  state.reviewDetailSequence += 1;
  state.reviewDetailRequestId = "";
  setReviewListState("loading", "確認待ち支払いを読み込み中です...");
  el.reviewsTableBody.innerHTML = "";

  const query = status ? `?status=${encodeURIComponent(status)}` : "";

  try {
    // M-031: the API is paginated; follow pages (bounded) so the operator UI
    // keeps full visibility instead of silently showing only the first page.
    const REVIEW_LIST_PAGE_LIMIT = 100;
    const REVIEW_LIST_MAX_PAGES = 20;
    const merged = [];
    let pageCursor = 0;
    for (; pageCursor < REVIEW_LIST_MAX_PAGES; pageCursor += 1) {
      const offset = pageCursor * REVIEW_LIST_PAGE_LIMIT;
      const pageQuery = `${query ? `${query}&` : "?"}limit=${REVIEW_LIST_PAGE_LIMIT}&offset=${offset}`;
      const pageData = await requestJson(`/api/v1/reviews${pageQuery}`);
      if (
        requestSequence !== state.reviewListSequence
        || state.reviewListFilter !== status
        || String(el.reviewStatusFilter.value || "") !== status
      ) return { status: "stale" };
      if (!Array.isArray(pageData.reviews)) break;
      merged.push(...pageData.reviews);
      if (pageData.reviews.length < REVIEW_LIST_PAGE_LIMIT) break;
    }
    const data = { reviews: merged };
    if (
      requestSequence !== state.reviewListSequence
      || state.reviewListFilter !== status
      || String(el.reviewStatusFilter.value || "") !== status
    ) return { status: "stale" };
    const rows = Array.isArray(data.reviews) ? [...data.reviews].sort(compareReviewsByPriority) : [];
    state.reviewRows = rows;
    renderReviewSummary(rows);
    if (rows.length === 0) {
      state.selectedReviewId = "";
      renderReviewDetail(null);
      setReviewListState("empty", "確認待ちの支払いはありません。");
      return { status: "ok", rows };
    }
    const activeRows = rows.filter((row) => ["open", "in_progress"].includes(String(row.status || "")));
    const topReview = activeRows[0] || null;
    setReviewListState(
      "empty",
      topReview
        ? `${rows.length} 件のレビュー。最優先: ${reviewReasonLabel(topReview.reason_type)}（${shortId(topReview.id)}）`
        : `${rows.length} 件のレビューがあります。`
    );
    for (const row of rows) {
      el.reviewsTableBody.appendChild(createReviewRow(row));
    }
    const nextSelection = rows.some((row) => row.id === state.selectedReviewId) ? state.selectedReviewId : rows[0]?.id;
    if (nextSelection) {
      await selectReview(nextSelection);
    }
    if (requestSequence !== state.reviewListSequence || state.reviewListFilter !== status) return { status: "stale" };
    highlightSelectedReviewRow();
    return { status: "ok", rows };
  } catch (error) {
    if (
      isIgnoredRequestError(error)
      || requestSequence !== state.reviewListSequence
      || state.reviewListFilter !== status
    ) return { status: "stale" };
    state.selectedReviewId = "";
    renderReviewDetail(null);
    renderReviewSummary([]);
    setReviewListState("error", "読み込みに失敗しました。もう一度お試しください。");
    showToast(String(error.message || error), true);
    return { status: "failed", error };
  }
}

async function stepUpForAccountingAdjustment() {
  const stepUpPin = String(el.reviewStepUpPin.value || "").trim();
  if (!/^\d{4,8}$/.test(stepUpPin)) {
    throw new Error("会計調整には4-8桁のstep-up PINが必要です");
  }
  await requestJson("/api/v1/terminal-sessions/current/step-up", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey("accounting-adjustment-step-up"),
    },
    body: JSON.stringify({ staff_pin: stepUpPin }),
  });
}

async function handleCreateAccountingAdjustment() {
  if (!requireUiPermission("accounting.adjustment.create", "会計調整の作成")) return;
  const invoiceId = String(el.reviewAdjustmentInvoiceId.value || "").trim();
  const reviewCaseId = String(el.reviewIdInput.value || "").trim();
  const adjustmentType = String(el.reviewAdjustmentType.value || "").trim();
  const amount = String(el.reviewAdjustmentAmount.value || "").trim();
  const reason = String(el.reviewAdjustmentReason.value || "").trim();
  const evidenceRef = String(el.reviewAdjustmentEvidenceRef.value || "").trim();
  if (!invoiceId || !reviewCaseId || !/^\d+$/.test(amount) || BigInt(amount || "0") <= 0n || reason.length < 10 || !evidenceRef) {
    showToast("請求・レビュー・正の調整額・10文字以上の理由・証拠参照を入力してください", true);
    return;
  }
  const operationSignature = buildAccountingAdjustmentSignature({
    invoiceId,
    reviewCaseId,
    adjustmentType,
    amount,
    reason,
    evidenceRef,
  });
  const operation = beginAccountingAdjustmentOperation(operationSignature);
  if (!operation) {
    showToast("同じ入力内容の会計調整を処理中です。完了までお待ちください", true);
    return;
  }
  if (operation.completed) {
    const savedAdjustment = operation.result?.accounting_adjustment;
    if (savedAdjustment?.id) {
      el.reviewAdjustmentId.value = savedAdjustment.id;
      renderAccountingAdjustmentHandoff(savedAdjustment);
    }
    showToast("同じ入力内容の会計調整は作成済みです。確認待ちIDを表示しました");
    endAccountingAdjustmentOperation(operation);
    return;
  }
  el.createAccountingAdjustmentBtn.disabled = true;
  try {
    await stepUpForAccountingAdjustment();
    const data = await requestJson("/api/v1/accounting-adjustments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operation.idempotencyKey,
      },
      body: JSON.stringify({
        invoice_id: invoiceId,
        review_case_id: reviewCaseId,
        adjustment_type: adjustmentType,
        amount_jpyc_base: amount,
        reason,
        evidence: { evidence_ref: evidenceRef },
      }),
    });
    const adjustment = data?.accounting_adjustment;
    if (!adjustment?.id) throw new Error("会計調整IDを取得できませんでした");
    operation.completed = true;
    operation.result = data;
    el.reviewAdjustmentId.value = adjustment.id;
    renderAccountingAdjustmentHandoff(adjustment);
    showToast("会計調整を作成しました。作成者の資格情報を引き継がず、別スタッフへ交代してください");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  } finally {
    endAccountingAdjustmentOperation(operation);
    el.reviewStepUpPin.value = "";
    el.createAccountingAdjustmentBtn.disabled = !hasPermission("accounting.adjustment.create");
  }
}

function renderAccountingAdjustmentHandoff(adjustment = null) {
  const id = String(adjustment?.id || el.reviewAdjustmentId?.value || "").trim();
  const status = String(adjustment?.status || "pending");
  const createdSessionId = String(adjustment?.created_session_id || "");
  const sameSession = Boolean(createdSessionId && createdSessionId === state.sessionId);
  const pending = Boolean(id && status === "pending");
  if (id && el.reviewAdjustmentId.value !== id) el.reviewAdjustmentId.value = id;
  el.handoffAccountingAdjustmentBtn?.classList.toggle("hidden", !pending || !sameSession);
  if (el.approveAccountingAdjustmentBtn) {
    el.approveAccountingAdjustmentBtn.disabled = !pending || sameSession || !hasPermission("accounting.adjustment.approve");
  }
  if (!pending) {
    el.accountingAdjustmentStatus.textContent = id ? `会計調整 ${id}: ${status || "状態不明"}` : "確認待ち一覧から対象を選択してください。";
  } else if (sameSession) {
    el.accountingAdjustmentStatus.textContent = `作成済み・承認待ち: ${id}。作成者のセッションでは承認できません。「承認者へ引き継ぐ」でログアウトしてください。`;
  } else {
    el.accountingAdjustmentStatus.textContent = `別スタッフで承認可能: ${id}。承認者本人のPINでstep-upしてください。`;
  }
}

function renderPendingAccountingAdjustments(rows = []) {
  state.pendingAdjustmentRows = Array.isArray(rows) ? rows : [];
  el.pendingAdjustmentSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.pendingAdjustmentRows.length > 0
    ? `${state.pendingAdjustmentRows.length}件から選択`
    : "確認待ちはありません";
  el.pendingAdjustmentSelect.appendChild(placeholder);
  for (const adjustment of state.pendingAdjustmentRows) {
    const option = document.createElement("option");
    option.value = String(adjustment.id || "");
    option.textContent = `${shortId(adjustment.id, 10, 5)} / ${shortId(adjustment.invoice_id, 10, 5)} / ${adjustment.adjustment_type || "調整"}`;
    el.pendingAdjustmentSelect.appendChild(option);
  }
}

async function loadPendingAccountingAdjustments({ selectId = "" } = {}) {
  if (!hasPermission("accounting.adjustment.read")) return [];
  const data = await requestJson("/api/v1/accounting-adjustments?status=pending");
  const rows = Array.isArray(data?.adjustments) ? data.adjustments : [];
  renderPendingAccountingAdjustments(rows);
  const preferred = String(selectId || state.pendingAdjustmentSelectedId || "").trim();
  if (preferred && rows.some((row) => String(row.id) === preferred)) {
    el.pendingAdjustmentSelect.value = preferred;
    state.pendingAdjustmentSelectedId = preferred;
    renderAccountingAdjustmentHandoff(rows.find((row) => String(row.id) === preferred));
  }
  return rows;
}

function selectPendingAccountingAdjustment(adjustmentId) {
  const id = String(adjustmentId || "").trim();
  state.pendingAdjustmentSelectedId = id;
  const row = state.pendingAdjustmentRows.find((item) => String(item.id) === id) || null;
  renderAccountingAdjustmentHandoff(row);
}

async function handleApproveAccountingAdjustment() {
  if (!requireUiPermission("accounting.adjustment.approve", "会計調整の承認")) return;
  const adjustmentId = String(el.reviewAdjustmentId.value || "").trim();
  if (!adjustmentId) {
    showToast("承認する会計調整IDを入力してください", true);
    return;
  }
  const pendingAdjustment = state.pendingAdjustmentRows.find((row) => String(row.id) === adjustmentId) || null;
  if (!pendingAdjustment) {
    showToast("確認待ち一覧を更新し、対象会計調整を選択してください", true);
    return;
  }
  if (String(pendingAdjustment.created_session_id || "") === state.sessionId) {
    showToast("作成者のセッションでは承認できません。ログアウトし、別スタッフ本人がログインしてください", true);
    return;
  }
  try {
    await stepUpForAccountingAdjustment();
    const data = await requestJson(`/api/v1/accounting-adjustments/${encodeURIComponent(adjustmentId)}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("accounting-adjustment-approve"),
      },
      body: "{}",
    });
    const adjustment = data?.accounting_adjustment;
    el.accountingAdjustmentStatus.textContent = `承認済み: ${adjustment?.id || adjustmentId}（別staff）`;
    state.pendingAdjustmentSelectedId = "";
    await loadPendingAccountingAdjustments();
    showToast("会計調整を承認しました。必要ならレビュー処分で承認済みIDを指定してください");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  } finally {
    el.reviewStepUpPin.value = "";
  }
}

async function handleUpdateReview() {
  if (!requireUiPermission("review.update", "レビュー更新")) return;
  const reviewId = String(el.reviewIdInput.value || "").trim();
  if (!reviewId) {
    showToast("レビューIDを入力してください", true);
    return;
  }
  const disposition = String(el.reviewDisposition.value || "").trim();
  const reviewUpdateBody = {
    status: el.reviewNextStatus.value,
    resolution_note: String(el.reviewNote.value || "").trim() || null,
    disposition: disposition || undefined,
    incident_id: String(el.reviewIncidentId.value || "").trim() || undefined,
    accounting_adjustment_id: disposition === "accounting_adjustment"
      ? String(el.reviewAdjustmentId.value || "").trim() || undefined
      : undefined,
  };
  const destructiveDisposition = disposition === "cancelled_no_sale"
    && ["resolved", "rejected"].includes(String(reviewUpdateBody.status || ""));
  const updateSignature = JSON.stringify({ review_id: reviewId, ...reviewUpdateBody });
  if (destructiveDisposition && state.pendingReviewUpdate !== updateSignature) {
    state.pendingReviewUpdate = updateSignature;
    el.updateReviewBtn.textContent = "対象請求を無効にしてレビューを更新";
    el.reviewUpdateImpact.textContent = `レビュー ${shortId(reviewId)} の更新により対象請求が無効になります。対象・状態・処分を再確認し、同じボタンをもう一度押してください。`;
    showToast("この更新は対象請求を無効にします。確認後、同じボタンをもう一度押してください", true);
    return;
  }
  state.pendingReviewUpdate = "";
  el.updateReviewBtn.textContent = "レビューを更新";
  try {
    const data = await requestJson(`/api/v1/reviews/${encodeURIComponent(reviewId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("review-update"),
      },
      body: JSON.stringify(reviewUpdateBody),
    });
    const actualInvoiceStatus = String(data?.invoice?.status || "");
    if (destructiveDisposition && actualInvoiceStatus !== "cancelled") {
      throw new Error("レビュー更新後の請求無効化を確認できません。最新状態を再取得してください");
    }
    state.reviewDrafts.delete(reviewId);
    state.reviewDraftDirty = false;
    el.reviewUpdateImpact.textContent = destructiveDisposition
      ? "レビューを更新し、対象請求が無効になったことを確認しました。"
      : "レビュー更新を保存しました。";
    showToast(destructiveDisposition ? "レビュー更新と対象請求の無効化を確認しました" : "レビューを更新しました");
    await loadReviews();
    await loadOpsSnapshot();
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  } finally {
    el.reviewNote.focus();
  }
}

function normalizeDecimalSignature(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return raw;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = String(match[2] || "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function buildRefundRequestSignature() {
  return JSON.stringify({
    review_case_id: String(el.refundReviewCaseId?.value || "").trim(),
    refund_amount_jpyc: normalizeDecimalSignature(el.refundAmount?.value),
    refund_to_address: String(el.refundAddress?.value || "").trim().toLowerCase(),
    refund_chain_id: String(el.refundChainId?.value || "").trim(),
  });
}

function clearPendingRefundExecute() {
  state.pendingRefundExecute = "";
  if (state.pendingRefundExecuteTimer) {
    clearTimeout(state.pendingRefundExecuteTimer);
    state.pendingRefundExecuteTimer = null;
  }
}

function buildRefundExecuteSignature() {
  return JSON.stringify({
    refund_id: String(el.refundIdInput?.value || "").trim(),
    refund_tx_hash: String(el.refundTxHashInput?.value || "").trim().toLowerCase(),
    executed_wallet: String(el.refundExecutedWalletInput?.value || "").trim().toLowerCase(),
    evidence_note_path: String(el.refundEvidenceNotePathInput?.value || "").trim(),
    customer_note: String(el.refundCustomerNoteInput?.value || "").trim(),
  });
}

function beginRefundOperation(kind, signature, refundId) {
  const targetRefundId = String(refundId || "").trim();
  if (!targetRefundId || state.refundOperationTargetsInFlight.has(targetRefundId)) return null;
  const operationSignature = `${kind}:${String(signature || "")}`;
  if (state.refundOperationsInFlight.has(operationSignature)) return null;
  state.refundOperationsInFlight.add(operationSignature);
  state.refundOperationTargetsInFlight.add(targetRefundId);
  syncRefundOperationInputs();
  updateRefundStepState();
  return {
    operationSignature,
    targetRefundId,
    idempotencyKey: getStableOperationKey(state.refundOperationKeys, kind, signature),
  };
}

function endRefundOperation(operation) {
  if (operation?.operationSignature) state.refundOperationsInFlight.delete(operation.operationSignature);
  if (operation?.targetRefundId) state.refundOperationTargetsInFlight.delete(operation.targetRefundId);
  syncRefundOperationInputs();
  updateRefundStepState();
}

function releaseRefundVerifyKeyAfterResult(operation, result) {
  if (!operation?.operationSignature) return;
  if (REFUND_VERIFY_RETRYABLE_STATUSES.has(String(result?.status || ""))) {
    state.refundOperationKeys.delete(operation.operationSignature);
  }
}

function releaseRefundVerifyKeyAfterError(operation, error) {
  if (!operation?.operationSignature || !Number.isInteger(error?.status)) return;
  if (error?.code === "IDEMPOTENCY_IN_PROGRESS") return;
  state.refundOperationKeys.delete(operation.operationSignature);
}

function syncRefundOperationInputs() {
  const busy = state.refundOperationsInFlight.size > 0;
  for (const input of [
    el.refundIdInput,
    el.refundTxHashInput,
    el.refundExecutedWalletInput,
    el.refundEvidenceNotePathInput,
    el.refundCustomerNoteInput,
  ]) {
    if (input) input.disabled = busy || state.refundRequestInFlight;
  }
}

function handleRefundDraftChanged() {
  const nextSignature = buildRefundRequestSignature();
  const stored = state.refundRequestOperations.get(nextSignature);
  state.refundRequestSignature = nextSignature;
  state.refundRequestIdempotencyKey = stored?.idempotencyKey || "";
  state.refundRequestCompletedSignature = stored?.completed ? nextSignature : "";
  clearPendingRefundExecute();
  updateRefundStepState();
}

function setRefundRequestBusy(busy) {
  state.refundRequestInFlight = busy;
  for (const input of [
    el.refundReviewCaseId,
    el.refundAmount,
    el.refundAddress,
    el.refundChainId,
    el.refundEvidenceNotePathInput,
    el.refundCustomerNoteInput,
  ]) {
    if (input) input.disabled = busy;
  }
  if (el.refundAddress) el.refundAddress.readOnly = true;
  syncRefundOperationInputs();
  updateRefundStepState();
}

function renderRefundRecord(refund) {
  if (!refund) return;
  state.currentRefund = refund;
  const refundId = String(refund.refund_request_id || refund.refund_case_id || refund.id || "");
  if (refundId && String(el.refundIdInput.value || "").trim() !== refundId) {
    clearPendingRefundExecute();
    state.refundReadSequence += 1;
    state.refundReadRequestId = "";
    el.refundIdInput.value = refundId;
  }
  const status = String(refund.status || "");
  const eligibleDisplay = refund.eligible_refund_amount_jpyc ?? refund.remaining_refund_amount_jpyc;
  if (eligibleDisplay != null) {
    el.refundEligibleHint.textContent = `サーバー確認済みの返金可能額: ${formatJpyc(eligibleDisplay)}`;
  } else if (refund.eligible_refund_amount_jpyc_base != null) {
    el.refundEligibleHint.textContent = `サーバー確認済みの返金可能額（最小単位）: ${refund.eligible_refund_amount_jpyc_base}`;
  }
  updateRefundStepState(status ? refundStatusLabel(status) : "証跡入力");
}

async function readBackRefund(refundId) {
  const requestedRefundId = String(refundId || "").trim();
  if (!requestedRefundId || !hasPermission("refund.view")) return null;
  const requestSequence = state.refundReadSequence + 1;
  state.refundReadSequence = requestSequence;
  state.refundReadRequestId = requestedRefundId;
  const data = await requestJson(`/api/v1/refunds/${encodeURIComponent(requestedRefundId)}`);
  if (
    requestSequence !== state.refundReadSequence
    || state.refundReadRequestId !== requestedRefundId
    || String(el.refundIdInput?.value || "").trim() !== requestedRefundId
  ) return null;
  const responseRefundId = String(data?.refund_request_id || data?.refund_case_id || data?.id || "");
  if (responseRefundId !== requestedRefundId) throw new Error("返金IDが一致しない応答を破棄しました");
  renderRefundRecord(data);
  return data;
}

async function tryReadBackRefund(refundId, completedLabel) {
  if (!hasPermission("refund.view")) return true;
  try {
    await readBackRefund(refundId);
    return true;
  } catch (error) {
    if (isIgnoredRequestError(error)) return false;
    el.executeRefundHint.classList.remove("hidden");
    el.executeRefundHint.textContent = `${completedLabel}は完了しましたが、最新状態の再取得に失敗しました。返金IDから再確認してください。`;
    return false;
  }
}

function isHexTxHash(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

async function handleRequestRefund() {
  if (!requireUiPermission("refund.request", "返金申請")) return;
  if (state.refundRequestInFlight) return;
  const reviewCaseId = String(el.refundReviewCaseId.value || "").trim();
  const refundAmount = Number(el.refundAmount.value);
  const refundToAddress = String(el.refundAddress.value || "").trim();
  const refundChainId = String(el.refundChainId.value || "").trim();
  const evidenceNotePath = String(el.refundEvidenceNotePathInput?.value || "").trim();
  const customerNote = String(el.refundCustomerNoteInput?.value || "").trim();
  if (
    !state.refundPayerAddressVerified
    || state.refundPayerAddressReviewId !== reviewCaseId
  ) {
    showToast("支払い元アドレスを一意に確認できないため返金申請を停止しています。管理者へ引き継いでください", true);
    return;
  }
  if (!reviewCaseId || !Number.isFinite(refundAmount) || refundAmount <= 0 || !refundToAddress || !refundChainId) {
    showToast("返金申請の入力項目を確認してください", true);
    return;
  }
  if (!isLikelyEvmAddress(refundToAddress)) {
    showToast("返金先アドレスは 0x から始まる40桁hexで入力してください", true);
    return;
  }
  const requestSignature = buildRefundRequestSignature();
  let requestOperation = state.refundRequestOperations.get(requestSignature);
  if (!requestOperation) {
    requestOperation = {
      idempotencyKey: idempotencyKey("refund-request"),
      completed: false,
      refundId: "",
      result: null,
    };
    state.refundRequestOperations.set(requestSignature, requestOperation);
  }
  state.refundRequestSignature = requestSignature;
  state.refundRequestIdempotencyKey = requestOperation.idempotencyKey;
  if (requestOperation.completed) {
    state.refundRequestCompletedSignature = requestSignature;
    if (requestOperation.result) renderRefundRecord(requestOperation.result);
    if (requestOperation.refundId && hasPermission("refund.view")) {
      await tryReadBackRefund(requestOperation.refundId, "返金申請の作成");
    }
    showToast("この入力内容の返金申請は作成済みです。同じ返金IDと状態を表示しました");
    return;
  }
  setRefundRequestBusy(true);
  try {
    const data = await requestJson("/api/v1/refunds", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": requestOperation.idempotencyKey,
      },
      body: JSON.stringify({
        review_case_id: reviewCaseId,
        refund_amount_jpyc: refundAmount,
        refund_to_address: refundToAddress,
        refund_chain_id: refundChainId,
        evidence_note_path: evidenceNotePath || null,
        customer_note: customerNote || null,
      }),
    });
    state.refundRequestCompletedSignature = requestSignature;
    requestOperation.completed = true;
    requestOperation.result = data;
    renderRefundRecord(data);
    const refundId = String(data.refund_request_id || data.refund_case_id || data.id || "");
    requestOperation.refundId = refundId;
    if (refundId) await tryReadBackRefund(refundId, "返金申請の作成");
    showToast("返金申請を作成しました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  } finally {
    setRefundRequestBusy(false);
  }
}

async function handleApproveRefund() {
  if (!requireUiPermission("refund.approve", "返金承認")) return;
  const refundId = String(el.refundIdInput.value || "").trim();
  if (!refundId) {
    showToast("返金IDを入力してください", true);
    return;
  }
  const operation = beginRefundOperation("refund-approve", refundId, refundId);
  if (!operation) return;
  try {
    const data = await requestJson(`/api/v1/refunds/${encodeURIComponent(refundId)}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operation.idempotencyKey,
      },
      body: "{}",
    });
    if (String(el.refundIdInput.value || "").trim() === refundId) {
      renderRefundRecord(data);
      await tryReadBackRefund(refundId, "返金申請の承認");
    }
    showToast("返金申請を承認しました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  } finally {
    endRefundOperation(operation);
  }
}

async function handleExecuteRefund() {
  if (!requireUiPermission("refund.execute", "返金記録の保存")) return;
  const refundId = String(el.refundIdInput.value || "").trim();
  if (!refundId) {
    showToast("返金IDを入力してください", true);
    return;
  }
  const txHash = String(el.refundTxHashInput.value || "").trim().toLowerCase();
  const executedWallet = String(el.refundExecutedWalletInput?.value || "").trim();
  const evidenceNotePath = String(el.refundEvidenceNotePathInput?.value || "").trim();
  const customerNote = String(el.refundCustomerNoteInput?.value || "").trim();
  if (!isHexTxHash(txHash)) {
    showToast("返金取引番号は 0x + 64桁hex で入力してください", true);
    return;
  }
  if (executedWallet && !isLikelyEvmAddress(executedWallet)) {
    showToast("返金に使った店舗ウォレットは 0x から始まる40桁hexで入力してください", true);
    return;
  }
  const executeSignature = buildRefundExecuteSignature();
  if (state.pendingRefundExecute !== executeSignature) {
    clearPendingRefundExecute();
    state.pendingRefundExecute = executeSignature;
    el.executeRefundHint.classList.remove("hidden");
    el.executeRefundHint.textContent =
      `外部ウォレットで返金を実行済みであることを確認してください。返金記録 ${shortId(txHash)} を保存するには同じボタンをもう一度押してください。`;
    showToast("返金記録の保存はもう一度押すと実行します", true);
    state.pendingRefundExecuteTimer = window.setTimeout(() => {
      if (state.pendingRefundExecute === executeSignature) state.pendingRefundExecute = "";
      state.pendingRefundExecuteTimer = null;
    }, 8000);
    return;
  }
  clearPendingRefundExecute();
  const operation = beginRefundOperation("refund-execute", executeSignature, refundId);
  if (!operation) return;
  try {
    const data = await requestJson(`/api/v1/refunds/${encodeURIComponent(refundId)}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operation.idempotencyKey,
      },
      body: JSON.stringify({
        executor_type: "manual",
        refund_tx_hash: txHash,
        executed_wallet: executedWallet || null,
        evidence_note_path: evidenceNotePath || null,
        customer_note: customerNote || null,
      }),
    });
    const targetStillCurrent = buildRefundExecuteSignature() === executeSignature;
    if (!targetStillCurrent) {
      showToast(`返金 ${shortId(refundId)} の記録保存は完了しました。現在の入力表示は上書きしません`);
      return;
    }
    renderRefundRecord(data);
    const readBackOk = await tryReadBackRefund(refundId, "返金記録の保存");
    el.executeRefundHint.classList.remove("hidden");
    if (!readBackOk) {
      updateRefundStepState(String(data.status || "証跡入力"));
    } else if (data.status === "recorded") {
      el.executeRefundHint.textContent = "返金記録を保存しました。検証待ちです。";
      updateRefundStepState("検証待ち");
    } else {
      el.executeRefundHint.textContent = refundStatusLabel(data.status);
      updateRefundStepState(refundStatusLabel(data.status));
    }
    showToast("返金記録を保存しました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    el.executeRefundHint.classList.remove("hidden");
    el.executeRefundHint.textContent = String(error.message || error);
    showToast(String(error.message || error), true);
  } finally {
    endRefundOperation(operation);
  }
}

async function handleVerifyRefund() {
  if (!requireUiPermission("refund.execute", "返金検証")) return;
  const refundId = String(el.refundIdInput.value || "").trim();
  if (!refundId) {
    showToast("返金IDを入力してください", true);
    return;
  }
  const txHash = String(el.refundTxHashInput.value || "").trim().toLowerCase();
  const payload = {};
  if (txHash) {
    if (!isHexTxHash(txHash)) {
      showToast("返金取引番号は 0x + 64桁hex で入力してください", true);
      return;
    }
    payload.refund_tx_hash = txHash;
  }

  const verifySignature = JSON.stringify({ refund_id: refundId, refund_tx_hash: txHash });
  const operation = beginRefundOperation("refund-verify", verifySignature, refundId);
  if (!operation) return;
  try {
    const data = await requestJson(`/api/v1/refunds/${encodeURIComponent(refundId)}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operation.idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    releaseRefundVerifyKeyAfterResult(operation, data);
    const targetStillCurrent = String(el.refundIdInput.value || "").trim() === refundId
      && String(el.refundTxHashInput.value || "").trim().toLowerCase() === txHash;
    if (!targetStillCurrent) {
      showToast(`返金 ${shortId(refundId)} の検証は完了しました。現在の入力表示は上書きしません`);
      return;
    }
    renderRefundRecord(data);
    const readBackOk = await tryReadBackRefund(refundId, "返金検証");
    el.executeRefundHint.classList.remove("hidden");
    if (readBackOk) {
      el.executeRefundHint.textContent =
        data.status === "succeeded" ? "返金記録の検証が完了しました。" : refundStatusLabel(data.status);
    }
    updateRefundStepState(data.status === "succeeded" ? "検証済み" : refundStatusLabel(data.status));
    showToast("返金検証を実行しました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    releaseRefundVerifyKeyAfterError(operation, error);
    el.executeRefundHint.classList.remove("hidden");
    el.executeRefundHint.textContent = String(error.message || error);
    showToast(String(error.message || error), true);
  } finally {
    endRefundOperation(operation);
  }
}

function settlementBlockerLabel(blocker) {
  const code = String(blocker?.code || "").trim().toUpperCase();
  const labels = {
    INTEGRITY_HOLD_ACTIVE: "支払い記録の整合性確認中の請求があります",
    ACTIVE_INVOICES_BLOCK_CLOSE: "処理中の請求があります",
    UNRESOLVED_REVIEWS: "未解決レビューがあります",
    ADMIN_APPROVAL_REQUIRED: "未解決レビューについて管理者承認が必要です",
    UNRESOLVED_REVIEW_REASON_REQUIRED: "未解決レビューを残す理由が必要です",
    UNRESOLVED_REFUNDS: "未完了の返金記録があります",
    ACCOUNTING_FINALITY_PENDING: "会計確定に必要な確認が完了していません",
    SETTLEMENT_HARD_GATE_BLOCKED: "日次締めの安全確認項目が未完了です",
  };
  const references = [
    ...(Array.isArray(blocker?.invoice_ids) ? blocker.invoice_ids : []),
    ...(Array.isArray(blocker?.refund_ids) ? blocker.refund_ids : []),
  ].map((value) => shortId(value)).filter(Boolean);
  const suffix = references.length > 0 ? `（対象: ${references.join(", ")}）` : "";
  return `${labels[code] || "未解決の安全確認項目があります。運用ログを確認してください"}${suffix}`;
}

function settlementPreviewFingerprint(preview) {
  if (!preview || typeof preview !== "object") return "";
  return JSON.stringify({
    business_date: String(preview.business_date || ""),
    timezone: String(preview.timezone || ""),
    contract_version: String(preview.contract_version || ""),
    ready: preview.ready === true,
    closed: preview.closed === true,
    totals: preview.totals || {},
    counts: preview.counts || {},
    blockers: Array.isArray(preview.blockers) ? preview.blockers : [],
  });
}

function syncSettlementCloseControl() {
  if (!el.closeSettlementBtn) return;
  const preview = state.settlementPreview;
  const currentDate = String(el.businessDateInput?.value || "").trim();
  const previewMatches = Boolean(preview && preview.business_date === currentDate);
  const ready = Boolean(previewMatches && preview.ready === true && preview.closed !== true && (preview.blockers || []).length === 0);
  if (el.loadSettlementPreviewBtn) {
    el.loadSettlementPreviewBtn.disabled = !hasPermission("settlement.close")
      || state.settlementPreviewInFlight
      || state.settlementCloseInFlight;
    el.loadSettlementPreviewBtn.textContent = state.settlementPreviewInFlight
      ? "締め前確認を取得中…"
      : previewMatches
        ? "締め前確認を再取得"
        : "締め前確認を読み込む";
  }
  el.closeSettlementBtn.textContent = "確認内容で日次締めを確定";
  el.closeSettlementBtn.disabled = !hasPermission("settlement.close")
    || !previewMatches
    || state.settlementCloseInFlight
    || state.settlementPreviewInFlight
    || !ready
    || el.settlementPreviewConfirm?.checked !== true;
}

function clearSettlementPreview({ hide = true } = {}) {
  state.pendingSettlementClose = "";
  state.settlementPreview = null;
  state.settlementPreviewSignature = "";
  if (el.settlementPreviewConfirm) {
    el.settlementPreviewConfirm.checked = false;
    el.settlementPreviewConfirm.disabled = true;
  }
  if (el.settlementConfirmPanel) el.settlementConfirmPanel.classList.toggle("hidden", hide);
  syncSettlementCloseControl();
}

function renderSettlementPreview(preview) {
  const blockers = Array.isArray(preview?.blockers) ? preview.blockers : [];
  const ready = preview?.ready === true && preview?.closed !== true && blockers.length === 0;
  state.settlementPreview = preview;
  state.settlementPreviewSignature = settlementPreviewFingerprint(preview);
  state.pendingSettlementClose = String(preview?.business_date || "");
  el.settlementConfirmPanel.classList.remove("hidden");
  el.settlementPreviewBadge.textContent = preview?.closed ? "締め済み" : ready ? "確定可能" : "締め停止";
  el.settlementPreviewBadge.className = `status-pill ${preview?.closed ? "s-blue" : ready ? "s-green" : "s-red"}`;
  el.settlementPreviewState.textContent = preview?.closed
    ? "この営業日は締め済みです。正式snapshotを再取得して確認してください。"
    : ready
      ? "サーバーの締め前確認でblockerはありません。件数と金額を確認してチェックしてください。"
      : "未解決項目があるため日次締めを停止しています。";
  const previewTimeZone = safeTimeZone(preview?.timezone || state.storeTimezone);
  el.settlementPreviewBusinessDate.textContent = preview?.business_date
    ? `${preview.business_date}（${previewTimeZone}）`
    : "-";
  el.settlementPreviewInvoiceCount.textContent = `${Number(preview?.totals?.invoice_count || 0).toLocaleString("ja-JP")}件`;
  el.settlementPreviewPaidCount.textContent = `${Number(preview?.totals?.paid_invoice_count || 0).toLocaleString("ja-JP")}件`;
  el.settlementPreviewReviewCount.textContent = `${Number(preview?.totals?.review_count || 0).toLocaleString("ja-JP")}件`;
  el.settlementPreviewBilledTotal.textContent = formatJpy(preview?.totals?.total_billed_jpy || 0);
  el.settlementPreviewPaidTotal.textContent = formatJpyc(preview?.totals?.total_paid_jpyc || 0);
  el.settlementPreviewBlockers.replaceChildren();
  const blockerRows = blockers.length > 0 ? blockers.map(settlementBlockerLabel) : ["締めを止めている項目はありません。"];
  for (const label of blockerRows) {
    const item = document.createElement("li");
    item.textContent = label;
    el.settlementPreviewBlockers.appendChild(item);
  }
  el.settlementPreviewConfirm.checked = false;
  el.settlementPreviewConfirm.disabled = !ready;
  syncSettlementCloseControl();
}

async function loadSettlementPreview(businessDate) {
  const preview = await requestJson(
    `/api/v1/settlements/daily:preview?business_date=${encodeURIComponent(businessDate)}`
  );
  if (String(el.businessDateInput?.value || "").trim() !== businessDate) return null;
  if (String(preview?.business_date || "") !== businessDate) throw new Error("対象営業日が一致しないpreviewを破棄しました");
  renderSettlementPreview(preview);
  return preview;
}

async function handleLoadSettlementPreview() {
  if (!requireUiPermission("settlement.close", "日次締めpreview取得")) return;
  if (state.settlementPreviewInFlight || state.settlementCloseInFlight) return;
  const businessDate = String(el.businessDateInput?.value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    showToast("対象営業日は YYYY-MM-DD 形式で入力してください", true);
    return;
  }
  state.settlementPreviewInFlight = true;
  syncSettlementCloseControl();
  try {
    await loadSettlementPreview(businessDate);
    showToast("締め前確認を読み込みました。対象日・件数・金額・blockerを確認してください");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    clearSettlementPreview({ hide: false });
    if (el.settlementPreviewState) el.settlementPreviewState.textContent = String(error.message || error);
    showToast(String(error.message || error), true);
  } finally {
    state.settlementPreviewInFlight = false;
    syncSettlementCloseControl();
  }
}

function settlementExportPointerKey(businessDate) {
  const storeId = String(state.storeId || "").trim();
  const date = String(businessDate || "").trim();
  return storeId && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? `jpyc_settlement_export_pointer:${storeId}:${date}`
    : "";
}

function rememberSettlementExportPointer(exportData) {
  const key = settlementExportPointerKey(exportData?.business_date || el.businessDateInput?.value);
  if (!key || !exportData?.export_id) return;
  writeSettingsStorage(key, String(exportData.export_id));
}

function renderSettlementExport(exportData) {
  const exportId = String(exportData?.export_id || "").trim();
  const runId = String(exportData?.export_run_id || "").trim();
  const contractVersion = String(exportData?.contract_version || "").trim();
  const contentHash = String(exportData?.content_hash || exportData?.content_hashes?.json || exportData?.content_hashes?.csv || "").trim();
  if (!exportId || !runId || !contractVersion || !contentHash) {
    throw new Error("正式snapshotのID・run・版・hashを確認できないため表示を停止しました");
  }
  state.settlementExport = {
    ...exportData,
    export_id: exportId,
    export_run_id: runId,
    contract_version: contractVersion,
    content_hash: contentHash,
  };
  el.settlementExportPanel.classList.remove("hidden");
  el.settlementExportStatus.textContent = "取得済み";
  el.settlementExportStatus.className = "status-pill s-green";
  el.settlementExportId.textContent = exportId;
  el.settlementExportRunId.textContent = runId;
  el.settlementExportVersion.textContent = contractVersion;
  el.settlementExportHash.textContent = contentHash;
  el.settlementExportHint.textContent = "サーバーから正式snapshotのID・run・版・hashを再取得しました。保存時にもhashを検証します。";
  rememberSettlementExportPointer(state.settlementExport);
}

async function loadSettlementExportById(exportId) {
  const normalizedId = String(exportId || "").trim();
  if (!normalizedId) return null;
  const data = await requestJson(`/api/v1/settlement-exports/${encodeURIComponent(normalizedId)}`);
  if (String(data?.export_id || "") !== normalizedId) throw new Error("正式snapshot IDが一致しない応答を破棄しました");
  renderSettlementExport(data);
  return data;
}

async function handleReloadSettlementExport() {
  if (!requireUiPermission("settlement.export", "正式snapshot再取得")) return;
  const businessDate = String(el.businessDateInput?.value || "").trim();
  const key = settlementExportPointerKey(businessDate);
  const rememberedId = key ? String(readSettingsStorage(key) || "").trim() : "";
  const exportId = String(state.settlementExport?.export_id || el.settlementExportId?.textContent || rememberedId).trim();
  if (!exportId || exportId === "-") {
    showToast("この端末に正式snapshot IDがありません。サーバーの履歴一覧が利用可能になってから再取得してください", true);
    return;
  }
  try {
    await loadSettlementExportById(exportId);
    showToast("正式snapshotを再取得しました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  }
}

async function handleDownloadSettlementExport(format) {
  if (!requireUiPermission("settlement.export", "正式snapshot保存")) return;
  const exportData = state.settlementExport;
  const exportId = String(exportData?.export_id || "").trim();
  if (!exportId || !["csv", "json"].includes(format)) {
    showToast("先に正式snapshotを再取得してください", true);
    return;
  }
  try {
    const { body, headers } = await requestBytes(
      `/api/v1/settlement-exports/${encodeURIComponent(exportId)}/download?format=${format}`,
      {},
      { timeoutMs: API_EXPORT_REQUEST_TIMEOUT_MS }
    );
    const responseContract = String(headers.get("x-settlement-export-contract-version") || "").trim();
    const responseHash = String(headers.get("x-content-sha256") || "").trim().toLowerCase();
    const actualHash = await sha256Hex(body);
    const expectedHash = String(exportData?.content_hashes?.[format] || "").trim().toLowerCase();
    if (!responseContract || responseContract !== exportData.contract_version) {
      throw new Error("正式snapshotの契約版が一致しないため保存を停止しました");
    }
    if (!responseHash || responseHash !== actualHash || (expectedHash && expectedHash !== actualHash)) {
      throw new Error("正式snapshotのhashが一致しないため保存を停止しました");
    }
    const disposition = headers.get("content-disposition");
    const fileName = disposition?.match(/filename="?([^";]+)"?/i)?.[1]
      || `settlement-export-${exportData.business_date || nowIsoDate()}-${exportId}.${format}`;
    downloadBytes(body, fileName, format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8");
    el.settlementExportHint.textContent = `${format.toUpperCase()}の契約版とSHA-256を検証して保存しました。`;
    showToast(`正式${format.toUpperCase()}を検証して保存しました`);
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    el.settlementExportHint.textContent = String(error.message || error);
    showToast(String(error.message || error), true);
  }
}

async function handleCloseSettlement() {
  if (!requireUiPermission("settlement.close", "日次締め")) return;
  if (state.settlementCloseInFlight) return;
  const businessDate = String(el.businessDateInput.value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    showToast("対象営業日は YYYY-MM-DD 形式で入力してください", true);
    return;
  }
  try {
    const currentPreview = state.settlementPreview;
    if (!currentPreview || currentPreview.business_date !== businessDate) {
      showToast("対象営業日の締め前確認を読み込み、内容を確認してください", true);
      return;
    }
    if (currentPreview.ready !== true || currentPreview.closed === true || (currentPreview.blockers || []).length > 0) {
      showToast("未解決項目があるため日次締めを実行できません", true);
      return;
    }
    if (el.settlementPreviewConfirm.checked !== true) {
      showToast("対象日・件数・金額・blockerを確認し、チェックしてください", true);
      return;
    }
    const confirmedSignature = state.settlementPreviewSignature;
    const freshPreview = await requestJson(
      `/api/v1/settlements/daily:preview?business_date=${encodeURIComponent(businessDate)}`
    );
    if (String(el.businessDateInput.value || "").trim() !== businessDate) {
      clearSettlementPreview();
      showToast("対象営業日が変わったため、締め前確認をやり直してください", true);
      return;
    }
    const freshSignature = settlementPreviewFingerprint(freshPreview);
    if (freshSignature !== confirmedSignature) {
      renderSettlementPreview(freshPreview);
      showToast("締め前確認の内容が変わりました。最新の件数・金額・blockerを再確認してください", true);
      return;
    }
    state.settlementPreview = freshPreview;
    state.settlementPreviewSignature = freshSignature;
    state.settlementCloseInFlight = true;
    el.businessDateInput.disabled = true;
    syncSettlementCloseControl();
    const closeKey = getStableOperationKey(state.settlementOperationKeys, "settlement-close", freshSignature);
    const data = await requestJson("/api/v1/settlements/daily:close", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": closeKey,
      },
      body: JSON.stringify({ business_date: businessDate }),
    });
    renderSettlementExport(data);
    el.settlementPreviewConfirm.checked = false;
    el.settlementPreviewConfirm.disabled = true;
    el.settlementPreviewBadge.textContent = "締め完了";
    el.settlementPreviewBadge.className = "status-pill s-green";
    el.closeSettlementHint.classList.remove("hidden");
    el.closeSettlementHint.textContent = data.warning === "UNRESOLVED_REVIEWS"
      ? `日次締めを完了しました。未解決レビュー ${Number(data.review_count || 0)}件を正式snapshotと運用記録で継続確認してください。`
      : "日次締めを完了し、正式Settlement Export snapshotを取得しました。";
    await loadOpsSnapshot();
    showToast("日次締めと正式snapshotの取得を確認しました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    el.closeSettlementHint.classList.remove("hidden");
    el.closeSettlementHint.textContent = String(error.message || error);
    showToast(String(error.message || error), true);
  } finally {
    state.settlementCloseInFlight = false;
    el.businessDateInput.disabled = false;
    syncSettlementCloseControl();
  }
}

async function handleExportAuditCsv() {
  if (!requireUiPermission("audit.export", "監査CSV出力")) return;
  try {
    const { body, headers } = await requestText(
      "/api/v1/audit-logs/export?format=csv&limit=1000",
      {},
      { timeoutMs: API_EXPORT_REQUEST_TIMEOUT_MS }
    );
    const exportWarning = String(headers.get("x-audit-export-warning") || "").trim();
    const truncationMetadata = String(headers.get("x-audit-export-truncated") || "").trim().toLowerCase();
    const exportComplete = String(headers.get("x-audit-export-complete") || "").trim().toLowerCase();
    if (
      exportWarning
      || ["1", "true", "yes"].includes(truncationMetadata)
      || exportComplete === "false"
      || headers.get("x-audit-export-next-cursor")
    ) {
      throw new Error("監査CSVが全件を含まないため保存を停止しました。cursor対応の完全exportを使用してください");
    }
    const nameHint = headers.get("content-disposition");
    const fileNameMatch = nameHint ? nameHint.match(/filename=\"?([^\";]+)\"?/) : null;
    const fileName = fileNameMatch?.[1] || `audit-${nowIsoDate()}.csv`;
    downloadBytes(new TextEncoder().encode(body), fileName, "text/csv;charset=utf-8");
    showToast("全件性に関する切り詰め警告がない監査CSVを保存しました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  }
}

async function handleOpenAuditLog() {
  if (!requireUiPermission("audit.read", "操作履歴の表示")) return;
  el.openAuditLogBtn.disabled = true;
  try {
    const data = await requestJson("/api/v1/audit-logs?limit=50");
    setAuditLogRows(data.audit_logs);
    el.auditLogPanel.classList.remove("hidden");
    showToast("認証済みの操作履歴を表示しました");
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    el.auditLogPanel.classList.add("hidden");
    showToast(String(error.message || error), true);
  } finally {
    el.openAuditLogBtn.disabled = !hasPermission("audit.read");
  }
}

async function handleExportMonthlyCsv() {
  if (!requireUiPermission("settlement.export", "月次CSV出力")) return;
  const yearMonth = String(el.businessMonthInput.value || "").trim();
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    showToast("対象月は YYYY-MM 形式で入力してください", true);
    return;
  }
  try {
    const { body, headers } = await requestText(
      `/api/v1/settlements/monthly:export?year_month=${encodeURIComponent(yearMonth)}&format=csv`,
      {},
      { timeoutMs: API_EXPORT_REQUEST_TIMEOUT_MS }
    );
    const nameHint = headers.get("content-disposition");
    const fileNameMatch = nameHint ? nameHint.match(/filename=\"?([^\";]+)\"?/) : null;
    const fileName = fileNameMatch?.[1] || `settlement-monthly-${yearMonth}.csv`;
    downloadBytes(new TextEncoder().encode(body), fileName, "text/csv;charset=utf-8");
    showToast(`${yearMonth} の運用用月次CSVを保存しました（正式snapshotではありません）`);
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    showToast(String(error.message || error), true);
  }
}

async function loadOpsWarnings() {
  if (!hasPermission("monitor.read")) {
    renderOpsWarningsList(["監視状態は現在の実効権限の対象外です"]);
    return;
  }
  try {
    const monitor = await requestJson("/api/v1/chain-monitor/status");
    renderOpsWarningsList(buildMonitorWarnings(monitor));
  } catch (error) {
    if (isIgnoredRequestError(error)) return;
    renderOpsWarningsList(["監視状態を取得できませんでした"]);
  }
}

function saveTerminalSettings() {
  writeTerminalSettings(
    {
      volume: Number(el.volumeInput.value || 0.8),
      auto_reset_sec: Number(el.autoResetSecInput.value || 120),
    },
    { showSavedToast: true }
  );
}

function loadTerminalSettings() {
  const settings = readTerminalSettings();
  el.volumeInput.value = String(settings.volume);
  el.autoResetSecInput.value = String(settings.auto_reset_sec);
  renderAmountPresetButtons();
}

function bindStorePaymentsEvents() {
  if (
    !el.storePaymentsMount
    || el.storePaymentsMount.dataset.eventsBound === "true"
    || !el.storePaymentsRefreshBtn
    || !el.storePaymentsToggleBtn
  ) return;
  el.storePaymentsRefreshBtn.addEventListener("click", () => void loadStorePaymentsState());
  el.storePaymentsToggleBtn.addEventListener("click", () => void handleStorePaymentsToggle());
  el.storePaymentsMount.dataset.eventsBound = "true";
}

function bindAdminEvents() {
  if (
    !el.adminOperationsMount
    || el.adminOperationsMount.dataset.eventsBound === "true"
    || !el.loadReviewsBtn
    || !el.reviewStatusFilter
    || !el.updateReviewBtn
  ) return;
  el.loadReviewsBtn.addEventListener("click", () => void loadReviews());
  el.reviewStatusFilter.addEventListener("change", () => void loadReviews());
  el.updateReviewBtn.addEventListener("click", () => void handleUpdateReview());
  for (const input of [
    el.reviewNextStatus,
    el.reviewDisposition,
    el.reviewIncidentId,
    el.reviewNote,
    el.reviewAdjustmentId,
    el.reviewAdjustmentType,
    el.reviewAdjustmentAmount,
    el.reviewAdjustmentReason,
    el.reviewAdjustmentEvidenceRef,
  ]) {
    input?.addEventListener("input", markReviewDraftDirty);
    input?.addEventListener("change", markReviewDraftDirty);
  }
  el.createAccountingAdjustmentBtn.addEventListener("click", () => void handleCreateAccountingAdjustment());
  el.approveAccountingAdjustmentBtn.addEventListener("click", () => void handleApproveAccountingAdjustment());
  el.loadPendingAdjustmentsBtn.addEventListener("click", () => {
    void loadPendingAccountingAdjustments().catch((error) => {
      if (!isIgnoredRequestError(error)) showToast(String(error.message || error), true);
    });
  });
  el.pendingAdjustmentSelect.addEventListener("change", () => {
    selectPendingAccountingAdjustment(el.pendingAdjustmentSelect.value);
  });
  el.handoffAccountingAdjustmentBtn.addEventListener("click", () => {
    el.accountingAdjustmentStatus.textContent = "作成者の資格情報を破棄します。次の承認者本人がログインしてください。";
    void handleLogout();
  });

  el.requestRefundBtn.addEventListener("click", () => void handleRequestRefund());
  for (const input of [
    el.refundReviewCaseId,
    el.refundAmount,
    el.refundAddress,
    el.refundChainId,
    el.refundEvidenceNotePathInput,
    el.refundCustomerNoteInput,
  ]) {
    input.addEventListener("input", handleRefundDraftChanged);
  }
  el.refundIdInput.addEventListener("input", () => {
    clearPendingRefundExecute();
    state.refundReadSequence += 1;
    state.refundReadRequestId = "";
    state.currentRefund = null;
    updateRefundStepState();
  });
  for (const input of [el.refundTxHashInput, el.refundExecutedWalletInput]) {
    input.addEventListener("input", clearPendingRefundExecute);
  }
  el.refundIdInput.addEventListener("change", () => {
    const refundId = String(el.refundIdInput.value || "").trim();
    if (refundId && hasPermission("refund.view")) {
      void readBackRefund(refundId).catch((error) => {
        if (isIgnoredRequestError(error)) return;
        showToast(String(error.message || error), true);
      });
    }
  });
  el.approveRefundBtn.addEventListener("click", () => void handleApproveRefund());
  el.executeRefundBtn.addEventListener("click", () => void handleExecuteRefund());
  el.verifyRefundBtn.addEventListener("click", () => void handleVerifyRefund());

  el.loadSettlementPreviewBtn.addEventListener("click", () => void handleLoadSettlementPreview());
  el.closeSettlementBtn.addEventListener("click", () => void handleCloseSettlement());
  el.settlementPreviewConfirm.addEventListener("change", syncSettlementCloseControl);
  el.downloadSettlementCsvBtn.addEventListener("click", () => void handleDownloadSettlementExport("csv"));
  el.downloadSettlementJsonBtn.addEventListener("click", () => void handleDownloadSettlementExport("json"));
  el.reloadSettlementExportBtn.addEventListener("click", () => void handleReloadSettlementExport());
  el.exportAuditCsvBtn.addEventListener("click", () => void handleExportAuditCsv());
  el.exportMonthlyCsvBtn.addEventListener("click", () => void handleExportMonthlyCsv());
  el.openAuditLogBtn.addEventListener("click", () => void handleOpenAuditLog());
  el.refreshOpsSnapshotBtn.addEventListener("click", () => void loadOpsSnapshot());
  el.businessDateInput.addEventListener("change", () => {
    clearSettlementPreview();
    state.settlementExport = null;
    el.settlementExportPanel.classList.add("hidden");
    if (!hasPermission("settlement.close")) return;
    void loadOpsSnapshot();
  });
  el.adminOperationsMount.dataset.eventsBound = "true";
}

function bindEvents() {
  el.loginBtn.addEventListener("click", () => void handleLogin());
  el.logoutBtn.addEventListener("click", () => void handleLogout());
  el.amountPresetList.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-preset-action]");
    if (!actionButton) return;
    const amount = actionButton.dataset.amountPreset || "";
    if (actionButton.dataset.presetAction === "use") {
      applyAmountPreset(amount);
      return;
    }
    if (actionButton.dataset.presetAction === "remove") {
      handleRemoveAmountPreset(amount);
    }
  });
  el.addPresetBtn.addEventListener("click", handleAddAmountPreset);
  el.resetPresetBtn.addEventListener("click", handleResetAmountPresets);
  el.paymentChainSelect.addEventListener("change", () => renderPaymentChains(state.paymentChains));
  el.presetAmountInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAddAmountPreset();
    }
  });
  el.createInvoiceBtn.addEventListener("click", () => void handleCreateInvoice());
  el.cancelInvoiceBtn.addEventListener("click", () => confirmDangerInvoiceAction("cancel", "請求を無効化"));
  el.expireInvoiceBtn.addEventListener("click", () => confirmDangerInvoiceAction("expire", "請求を期限切れに"));
  el.refreshBtn.addEventListener("click", () => {
    if (!requireUiPermission("invoice.read", "請求の最新状態取得")) return;
    if (!state.invoiceId) return;
    void loadInvoice(state.invoiceId);
  });
  if (el.connectionRefreshBtn) {
    el.connectionRefreshBtn.addEventListener("click", () => {
      if (state.token && state.storeId) void loadStorePaymentsState({ silent: true });
      if (state.invoiceId) {
        if (!requireUiPermission("invoice.read", "請求の最新状態取得")) return;
        void loadInvoice(state.invoiceId);
        return;
      }
      void loadOpsWarnings();
    });
  }
  el.reissueInvoiceBtn.addEventListener("click", () => void handleReissueInvoice());
  if (el.invoiceConsentCheckbox) {
    el.invoiceConsentCheckbox.addEventListener("change", syncConsentControls);
  }
  if (el.recordConsentBtn) {
    el.recordConsentBtn.addEventListener("click", () => void handleRecordInvoiceConsent());
  }
  if (PROVIDER_RAIL_ENABLED && el.presentTapBtn && el.resumeQrBtn) {
    el.presentTapBtn.addEventListener("click", () => void handlePresentTap());
    el.resumeQrBtn.addEventListener("click", () => void handleResumeQr());
  }

  el.saveSettingsBtn.addEventListener("click", saveTerminalSettings);

  window.addEventListener("beforeunload", () => {
    closeSse();
    stopFallbackPolling();
    stopOpsAutoRefresh();
    stopSessionExpiryTimer();
    if (typeof releaseScreenWakeLock === "function") void releaseScreenWakeLock();
  });
  window.addEventListener("pageshow", refreshFulfillmentObservationAfterResume);
  window.addEventListener("online", refreshFulfillmentObservationAfterResume);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshFulfillmentObservationAfterResume();
      const localPaymentQrDisplayed = state.deploymentTopology === "local_store_terminal"
        && state.currentInvoice?.customer_policy_consent?.recorded === true
        && Boolean(String(state.currentInvoice?.payment_uri || "").trim());
      const qrDisplayed = state.fixedQrUrl || localPaymentQrDisplayed;
      if (qrDisplayed && !el.qrCanvas.classList.contains("hidden") && typeof requestScreenWakeLock === "function") {
        void requestScreenWakeLock();
      }
    } else {
      if (typeof releaseScreenWakeLock === "function") void releaseScreenWakeLock();
    }
  });
  window.addEventListener("resize", () => {
    if (state.deploymentTopology === "local_store_terminal") {
      renderCustomerFacingDisplay(state.currentInvoice);
      renderSitesGuide();
      return;
    }
    if (state.fixedQrUrl && !el.qrCanvas.classList.contains("hidden")) drawQr(state.fixedQrUrl);
  });
}

function init() {
  if (!["localhost", "127.0.0.1", ""].includes(window.location.hostname)) {
    document.querySelectorAll(".dev-only-link").forEach((node) => node.classList.add("hidden"));
  }
  clearInvoiceView();
  setLoggedInUi(false);
  loadTerminalSettings();
  bindEvents();
  applyPermissionVisibility();
  renderReviewSummary([]);
  setReviewListState("empty", "ログイン後に確認待ち一覧を読み込めます。");
  renderReviewDetail(null);
  if (el.opsSnapshotState) {
    el.opsSnapshotState.textContent = "ログイン後に review / settlement / monitor を集約し、優先確認項目を表示します。";
    el.opsOpenReviewCount.textContent = "-";
    el.opsDeadLetterCount.textContent = "-";
    el.opsSettlementStatus.textContent = "-";
    el.opsRecommendedAction.textContent = "-";
    el.opsPriorityReview.textContent = "-";
    el.opsRefundCandidateCount.textContent = "-";
    setChecklist(el.opsSnapshotChecklist, ["小規模現場向けに、必要な運用項目だけをコンパクトに表示します。"]);
    el.businessDateInput.value = nowIsoDate();
    el.businessMonthInput.value = nowIsoDate().slice(0, 7);
    el.businessTimezoneText.textContent = state.storeTimezone;
  }
  setNetworkStatus("未接続");
  updateRefundStepState();
  renderDiagnostics();
  renderOperatorGuide();
}

init();
