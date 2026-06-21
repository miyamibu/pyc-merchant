const ACTIVE_INVOICE_STATUSES = new Set(["issued", "payment_detected", "confirming"]);
const FINAL_INVOICE_STATUSES = new Set(["paid", "review_required", "expired", "cancelled", "settled"]);
const INVOICE_STATUS_ALIASES = Object.freeze({
  manual_review: "review_required",
});
const FALLBACK_POLL_INTERVAL_MS = 10_000;
const INVOICE_DANGER_CONFIRM_MS = 5_000;
const REFUND_EXECUTE_CONFIRM_MS = 8_000;
const SETTLEMENT_CLOSE_CONFIRM_MS = 10_000;
const SETTINGS_KEY = "jpyc_terminal_settings";
const DEFAULT_AMOUNT_PRESETS = Object.freeze([500, 1000, 3000, 5000, 10000]);
const DEFAULT_TERMINAL_SETTINGS = Object.freeze({
  volume: 0.8,
  brightness: 0.7,
  display_font_size: "standard",
  auto_reset_sec: 120,
});
const MAX_AMOUNT_PRESET_COUNT = 12;
const FONT_SIZE_OPTIONS = new Set(["small", "standard", "large"]);
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
const REFUND_CHAIN_LABELS = Object.freeze({
  1: "Ethereum",
  137: "Polygon",
  43114: "Avalanche",
});
const OFFICIAL_JPYC_CONTRACT_DISPLAY = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
const ADDRESS_POOL_WARN_THRESHOLD = 5;
const WORKER_STALE_WARN_SEC = 300;
const OPS_AUTO_REFRESH_INTERVAL_MS = 60_000;
let localSimulatorAutoLoginStarted = false;

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
  terminalId: "",
  storeId: "",
  sessionId: "",
  role: "",
  supportedWallets: [],
  paymentChains: [],
  selectedPaymentChainId: "",
  fixedQrUrl: "",
  fixedQrToken: "",
  invoiceId: "",
  invoiceStatus: "",
  currentInvoice: null,
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
  reviewRows: [],
  selectedReviewId: "",
  selectedReviewDetail: null,
  autoRefreshTimer: null,
  pendingDangerAction: "",
  pendingDangerTimer: null,
  pendingDangerCountdownTimer: null,
  pendingRefundExecute: false,
  refundWorkflowStatus: "draft",
  pendingRefundExecuteTimer: null,
  pendingRefundExecuteCountdownTimer: null,
  pendingSettlementClose: "",
  pendingSettlementCloseTimer: null,
  pendingSettlementCloseCountdownTimer: null,
  activeTab: "billing",
  storeName: "",
  staffName: "",
};

const el = {
  terminalCode: document.getElementById("terminalCode"),
  staffPin: document.getElementById("staffPin"),
  staffPinConfirm: document.getElementById("staffPinConfirm"),
  staffNameInput: document.getElementById("staffNameInput"),
  loginFormPanel: document.getElementById("loginFormPanel"),
  staffPinConfirmLabel: document.getElementById("staffPinConfirmLabel"),
  loginBtn: document.getElementById("loginBtn"),
  loginStartPanel: document.getElementById("loginStartPanel"),
  terminalTabNav: document.getElementById("terminalTabNav"),
  terminalWorkspace: document.getElementById("terminalWorkspace"),
  adminLoginShortcutBtn: document.getElementById("adminLoginShortcutBtn"),
  loginStatusDetailBtn: document.getElementById("loginStatusDetailBtn"),
  lockTerminalBtn: document.getElementById("lockTerminalBtn"),
  logoutTerminalBtn: document.getElementById("logoutTerminalBtn"),
  sessionText: document.getElementById("sessionText"),
  settingsStoreName: document.getElementById("settingsStoreName"),
  settingsStaffName: document.getElementById("settingsStaffName"),
  networkText: document.getElementById("networkText"),
  connectionStatusPanel: document.getElementById("connectionStatusPanel"),
  connectionStatusText: document.getElementById("connectionStatusText"),
  connectionStatusHint: document.getElementById("connectionStatusHint"),
  connectionRefreshBtn: document.getElementById("connectionRefreshBtn"),
  apiHealthText: document.getElementById("apiHealthText"),
  updateRouteText: document.getElementById("updateRouteText"),
  terminalDiagnosticsPanel: document.getElementById("terminalDiagnosticsPanel"),
  terminalDiagnosticsBody: document.getElementById("terminalDiagnosticsBody"),
  sessionExpiryText: document.getElementById("sessionExpiryText"),
  volumeInput: document.getElementById("volumeInput"),
  volumePercentText: document.getElementById("volumePercentText"),
  testNotificationSoundBtn: document.getElementById("testNotificationSoundBtn"),
  brightnessInput: document.getElementById("brightnessInput"),
  brightnessPercentText: document.getElementById("brightnessPercentText"),
  fontSizeButtons: Array.from(document.querySelectorAll("[data-font-size-option]")),
  showOpsWarningsBtn: document.getElementById("showOpsWarningsBtn"),
  openAuditLogsBtn: document.getElementById("openAuditLogsBtn"),
  settingsAdminResultPanel: document.getElementById("settingsAdminResultPanel"),
  settingsAdminResultTitle: document.getElementById("settingsAdminResultTitle"),
  settingsAdminResultDescription: document.getElementById("settingsAdminResultDescription"),
  settingsAdminResultBody: document.getElementById("settingsAdminResultBody"),
  closeSettingsAdminResultBtn: document.getElementById("closeSettingsAdminResultBtn"),
  autoResetSecInput: document.getElementById("autoResetSecInput"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  opsWarnings: document.getElementById("opsWarnings"),
  amountInput: document.getElementById("amountInput"),
  amountJpycPreview: document.getElementById("amountJpycPreview"),
  amountInputError: document.getElementById("amountInputError"),
  paymentChainList: document.getElementById("paymentChainList"),
  paymentChainSummary: document.getElementById("paymentChainSummary"),
  paymentChainHint: document.getElementById("paymentChainHint"),
  officialContractBadge: document.getElementById("officialContractBadge"),
  amountPresetList: document.getElementById("amountPresetList"),
  presetAmountInput: document.getElementById("presetAmountInput"),
  addPresetBtn: document.getElementById("addPresetBtn"),
  resetPresetBtn: document.getElementById("resetPresetBtn"),
  createInvoiceBtn: document.getElementById("createInvoiceBtn"),
  cancelInvoiceBtn: document.getElementById("cancelInvoiceBtn"),
  expireInvoiceBtn: document.getElementById("expireInvoiceBtn"),
  stopQrReasonSelect: document.getElementById("stopQrReasonSelect"),
  stopQrConfirmHint: document.getElementById("stopQrConfirmHint"),
  invoiceDangerActions: document.getElementById("invoiceDangerActions"),
  invoiceStatusPill: document.getElementById("invoiceStatusPill"),
  billingCurrentPanel: document.querySelector(".billing-current-panel"),
  billingCurrentEmptyHint: document.getElementById("billingCurrentEmptyHint"),
  invoiceIdText: document.getElementById("invoiceIdText"),
  fixedQrUrlLink: document.getElementById("fixedQrUrlLink"),
  paymentUrlLink: document.getElementById("paymentUrlLink"),
  paymentUrlRow: document.getElementById("paymentUrlRow"),
  copyPaymentUrlBtn: document.getElementById("copyPaymentUrlBtn"),
  qrCanvas: document.getElementById("qrCanvas"),
  qrAccessibleText: document.getElementById("qrAccessibleText"),
  expiresAtText: document.getElementById("expiresAtText"),
  amountText: document.getElementById("amountText"),
  paidText: document.getElementById("paidText"),
  paymentChainText: document.getElementById("paymentChainText"),
  paymentContractText: document.getElementById("paymentContractText"),
  amountComparePanel: document.getElementById("amountComparePanel"),
  amountCompareExpected: document.getElementById("amountCompareExpected"),
  amountComparePaid: document.getElementById("amountComparePaid"),
  amountCompareDelta: document.getElementById("amountCompareDelta"),
  reasonText: document.getElementById("reasonText"),
  providerOperatorStateText: document.getElementById("providerOperatorStateText"),
  providerStatusText: document.getElementById("providerStatusText"),
  handoverNote: document.getElementById("handoverNote"),
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
  reviewSearchInput: document.getElementById("reviewSearchInput"),
  reviewCardList: document.getElementById("reviewCardList"),
  reviewSummaryChips: document.getElementById("reviewSummaryChips"),
  reviewListState: document.getElementById("reviewListState"),
  reviewDetailBadge: document.getElementById("reviewDetailBadge"),
  reviewDetailSummary: document.getElementById("reviewDetailSummary"),
  reviewDetailReasonText: document.getElementById("reviewDetailReasonText"),
  reviewDetailExpectedAmount: document.getElementById("reviewDetailExpectedAmount"),
  reviewDetailPaidAmount: document.getElementById("reviewDetailPaidAmount"),
  reviewDetailDeltaAmount: document.getElementById("reviewDetailDeltaAmount"),
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
  reviewNote: document.getElementById("reviewNote"),
  updateReviewBtn: document.getElementById("updateReviewBtn"),
  reviewHoldBtn: document.getElementById("reviewHoldBtn"),
  reviewRejectBtn: document.getElementById("reviewRejectBtn"),
  refundReviewCaseId: document.getElementById("refundReviewCaseId"),
  refundAmount: document.getElementById("refundAmount"),
  refundAddress: document.getElementById("refundAddress"),
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
  refundStepRequestBadge: document.getElementById("refundStepRequestBadge"),
  refundStepApproveBadge: document.getElementById("refundStepApproveBadge"),
  refundStepEvidenceBadge: document.getElementById("refundStepEvidenceBadge"),
  refreshRefundsBtn: document.getElementById("refreshRefundsBtn"),
  refundCaseListState: document.getElementById("refundCaseListState"),
  refundSourceInvoice: document.getElementById("refundSourceInvoice"),
  refundSourceAmounts: document.getElementById("refundSourceAmounts"),
  refundSourceEligible: document.getElementById("refundSourceEligible"),
  refundSummaryAmount: document.getElementById("refundSummaryAmount"),
  refundSummaryAddress: document.getElementById("refundSummaryAddress"),
  refundSummaryReason: document.getElementById("refundSummaryReason"),
  refundEvidencePathHint: document.getElementById("refundEvidencePathHint"),
  refundStepRequestIndicator: document.getElementById("refundStepRequestIndicator"),
  refundStepApproveIndicator: document.getElementById("refundStepApproveIndicator"),
  refundStepEvidenceIndicator: document.getElementById("refundStepEvidenceIndicator"),
  refundStepVerifyIndicator: document.getElementById("refundStepVerifyIndicator"),
  businessDateInput: document.getElementById("businessDateInput"),
  businessMonthInput: document.getElementById("businessMonthInput"),
  businessDateHeaderText: document.getElementById("businessDateHeaderText"),
  closeSettlementBtn: document.getElementById("closeSettlementBtn"),
  settlementConfirmPanel: document.getElementById("settlementConfirmPanel"),
  settlementBlockerTitle: document.getElementById("settlementBlockerTitle"),
  settlementBlockerReason: document.getElementById("settlementBlockerReason"),
  settlementBlockerNext: document.getElementById("settlementBlockerNext"),
  settlementCompletionNote: document.getElementById("settlementCompletionNote"),
  settlementChecklist: document.getElementById("settlementChecklist"),
  settlementSalesText: document.getElementById("settlementSalesText"),
  settlementPaidText: document.getElementById("settlementPaidText"),
  settlementRefundText: document.getElementById("settlementRefundText"),
  settlementDeltaText: document.getElementById("settlementDeltaText"),
  settlementPaymentCountText: document.getElementById("settlementPaymentCountText"),
  settlementReviewCountText: document.getElementById("settlementReviewCountText"),
  settlementRefundCandidateText: document.getElementById("settlementRefundCandidateText"),
  settlementUnresolvedList: document.getElementById("settlementUnresolvedList"),
  exportAuditCsvBtn: document.getElementById("exportAuditCsvBtn"),
  exportAuditLogCsvBtn: document.getElementById("exportAuditLogCsvBtn"),
  exportMonthlyCsvBtn: document.getElementById("exportMonthlyCsvBtn"),
  closeSettlementHint: document.getElementById("closeSettlementHint"),
  toastHost: document.getElementById("toastHost"),
  adminSections: Array.from(document.querySelectorAll("[data-admin-only='true']")),
  tabButtons: Array.from(document.querySelectorAll("[data-tab-target]")),
  tabPanels: Array.from(document.querySelectorAll("[data-tab-panel]")),
  topbarConnectionText: document.getElementById("topbarConnectionText"),
  topbarConnectionDot: document.getElementById("topbarConnectionDot"),
  topbarStoreText: document.getElementById("topbarStoreText"),
  topbarTerminalNameText: document.getElementById("topbarTerminalNameText"),
  topbarBusinessDateText: document.getElementById("topbarBusinessDateText"),
  topbarOpenReviewCount: document.getElementById("topbarOpenReviewCount"),
  topbarRolePill: document.getElementById("topbarRolePill"),
  topbarSessionText: document.getElementById("topbarSessionText"),
  topbarRefundStatusPill: document.getElementById("topbarRefundStatusPill"),
  topbarRefundTimelineText: document.getElementById("topbarRefundTimelineText"),
  reviewsLastUpdatedText: document.getElementById("reviewsLastUpdatedText"),
  refundsLastUpdatedText: document.getElementById("refundsLastUpdatedText"),
  settlementLastUpdatedText: document.getElementById("settlementLastUpdatedText"),
  billingWaitingPill: document.getElementById("billingWaitingPill"),
  tabBadgeReviews: document.getElementById("tabBadgeReviews"),
  tabBadgeRefunds: document.getElementById("tabBadgeRefunds"),
  tabBadgeSettlement: document.getElementById("tabBadgeSettlement"),
  goRefundFromReviewBtn: document.getElementById("goRefundFromReviewBtn"),
  reviewMobileBackBtn: document.getElementById("reviewMobileBackBtn"),
};

function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function idempotencyKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isAdminRole(role) {
  return role === "admin" || role === "manager";
}

function chainLabel(chainId) {
  return REFUND_CHAIN_LABELS[Number(chainId)] || String(chainId || "-");
}

function selectedPaymentChain() {
  return state.paymentChains.find((chain) => String(chain.chain_id) === String(state.selectedPaymentChainId)) || null;
}

function renderPaymentChains() {
  if (!el.paymentChainList) return;
  const chains = Array.isArray(state.paymentChains) ? state.paymentChains : [];
  if (el.officialContractBadge) el.officialContractBadge.textContent = "公式JPYC ...C3c29";
  el.paymentChainList.innerHTML = "";
  if (chains.length === 0) {
    if (el.paymentChainSummary) el.paymentChainSummary.textContent = "未取得";
    el.paymentChainHint.textContent = "";
    return;
  }
  if (!chains.some((chain) => String(chain.chain_id) === String(state.selectedPaymentChainId))) {
    state.selectedPaymentChainId = "";
  }
  for (const chain of chains) {
    const chainId = String(chain.chain_id);
    const available = chain.issue_available !== false && chain.status !== "unavailable";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "payment-chain-option";
    button.dataset.chainId = chainId;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(chainId === String(state.selectedPaymentChainId)));
    button.disabled = !available || Boolean(state.invoiceId && ACTIVE_INVOICE_STATUSES.has(state.invoiceStatus));
    button.innerHTML = `
      <span class="payment-chain-name">${escapeHtml(chain.short_name || chain.network || chainLabel(chainId))}</span>
    `;
    button.addEventListener("click", () => {
      if (!available) return;
      state.selectedPaymentChainId = chainId;
      button.closest("details")?.removeAttribute("open");
      renderPaymentChains();
      updateAmountPreview();
    });
    el.paymentChainList.appendChild(button);
  }
  const selected = selectedPaymentChain();
  const suffix = selected?.token_contract_suffix || "...C3c29";
  if (el.paymentChainSummary) el.paymentChainSummary.textContent = selected
    ? selected.short_name || selected.network || chainLabel(selected.chain_id)
    : "選択する";
  el.paymentChainHint.textContent = "";
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
  return dt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
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

function formatShortTime(value = new Date()) {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function setLastUpdated(elm, value = new Date()) {
  if (elm) elm.textContent = formatShortTime(value);
}

function setStatusPill(elm, label, className = "s-gray") {
  if (!elm) return;
  elm.textContent = label;
  elm.className = `status-pill ${className}`;
}

function renderTopbarRole() {
  const roleLabel = state.role ? formatRole(state.role) : "未ログイン";
  if (el.topbarRolePill) el.topbarRolePill.textContent = state.role ? `${roleLabel}モード` : "未ログイン";
  if (el.topbarSessionText) el.topbarSessionText.textContent = state.sessionId ? roleLabel : "未ログイン";
}

function renderSettingsSessionSummary() {
  const roleLabel = state.role ? formatRole(state.role) : "";
  if (el.settingsStoreName) el.settingsStoreName.textContent = state.storeName || "未ログイン";
  if (el.settingsStaffName) {
    const staffLabel = state.staffName || "スタッフ未選択";
    el.settingsStaffName.textContent = roleLabel ? `${staffLabel}・${roleLabel}` : staffLabel;
  }
}

function setSettlementChecklist(items) {
  if (!el.settlementChecklist) return;
  el.settlementChecklist.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.className = item.kind || "warn";
    const icon = document.createElement("span");
    icon.textContent = item.kind === "done" ? "✓" : "!";
    const label = document.createTextNode(item.label);
    const stateText = document.createElement("strong");
    stateText.textContent = item.state;
    li.append(icon, label, stateText);
    el.settlementChecklist.appendChild(li);
  }
}

function appendSettlementUnresolvedItem({ pill, pillClass, title, detail, tabTarget }) {
  if (!el.settlementUnresolvedList) return;
  const article = document.createElement("article");
  const status = document.createElement("span");
  status.className = `status-pill ${pillClass}`;
  status.textContent = pill;
  const body = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = detail;
  body.append(heading, copy);
  const button = document.createElement("button");
  button.className = "btn btn-secondary btn-compact";
  button.type = "button";
  button.dataset.tabTargetProxy = tabTarget;
  button.textContent = tabTarget === "refunds" ? "返金へ進む ›" : "確認待ちへ進む ›";
  button.addEventListener("click", () => setActiveTab(tabTarget));
  article.append(status, body, button);
  el.settlementUnresolvedList.appendChild(article);
}

function renderSettlementUnresolved(openReviewCount, refundCandidateCount) {
  if (!el.settlementUnresolvedList) return;
  el.settlementUnresolvedList.innerHTML = "";
  if (openReviewCount === 0 && refundCandidateCount === 0) {
    const note = document.createElement("p");
    note.className = "ops-note";
    note.textContent = "未解決事項はありません。締め前に操作履歴を確認してください。";
    el.settlementUnresolvedList.appendChild(note);
    return;
  }
  if (openReviewCount > 0) {
    appendSettlementUnresolvedItem({
      pill: "要対応",
      pillClass: "s-yellow",
      title: `確認待ちレビュー ${openReviewCount}件`,
      detail: "確認待ち一覧で理由・取引番号・商品引渡し可否を確認してください。",
      tabTarget: "reviews",
    });
  }
  if (refundCandidateCount > 0) {
    appendSettlementUnresolvedItem({
      pill: "返金確認",
      pillClass: "s-blue",
      title: `返金候補レビュー ${refundCandidateCount}件`,
      detail: "返金が必要な場合は、外部ウォレット実行後の証跡を登録してください。",
      tabTarget: "refunds",
    });
  }
  const note = document.createElement("p");
  note.className = "ops-note";
  note.textContent = "未解決事項をすべて解決すると、締めが可能になります。";
  el.settlementUnresolvedList.appendChild(note);
}

function renderTopbarRefundSummary(openReviewCount, refundCandidateCount) {
  const hasRefundCandidates = refundCandidateCount > 0;
  const hasOpenReviews = openReviewCount > 0;
  setStatusPill(
    el.topbarRefundStatusPill,
    hasRefundCandidates ? `返金候補 ${refundCandidateCount}件` : hasOpenReviews ? "確認待ちあり" : "要対応なし",
    hasRefundCandidates ? "s-yellow" : hasOpenReviews ? "s-blue" : "s-green"
  );
  if (el.topbarRefundTimelineText) {
    el.topbarRefundTimelineText.textContent = hasRefundCandidates
      ? `返金候補レビュー ${refundCandidateCount}件を確認してください`
      : hasOpenReviews
        ? `未解決レビュー ${openReviewCount}件を確認してください`
        : "返金候補・未解決レビューはありません";
  }
}

function renderSettlementDashboard({
  businessDate,
  settlementClosed,
  settlement,
  openReviewCount,
  refundCandidateCount,
}) {
  const blocked = openReviewCount > 0 || refundCandidateCount > 0;
  const statusLabel = settlementClosed
    ? "締め済み"
    : blocked
      ? `締め不可：未解決レビュー ${openReviewCount}件、返金候補 ${refundCandidateCount}件`
      : "締め前チェック完了";
  if (el.settlementBlockerTitle) el.settlementBlockerTitle.textContent = statusLabel;
  const blocker = el.settlementBlockerTitle?.closest(".settlement-blocker-banner");
  if (blocker) {
    blocker.classList.remove("settlement-blocker-banner-neutral", "settlement-blocker-banner-ready");
    blocker.setAttribute("role", blocked ? "alert" : "status");
    if (!blocked) blocker.classList.add(settlementClosed ? "settlement-blocker-banner-neutral" : "settlement-blocker-banner-ready");
  }
  if (el.settlementBlockerReason) {
    el.settlementBlockerReason.textContent = blocked
      ? "未解決事項が残っているため、日次締めを確定できません。"
      : settlementClosed
        ? `${businessDate} の日次締めは完了済みです。`
        : "未解決レビューと返金候補はありません。";
  }
  if (el.settlementBlockerNext) {
    el.settlementBlockerNext.textContent = blocked
      ? "確認待ちまたは返金候補を処理してから日次締めを確定してください。"
      : settlementClosed
        ? "必要に応じてCSVや監査ログを確認してください。"
        : "操作履歴を確認し、問題がなければ日次締めを確定してください。";
  }
  if (el.settlementCompletionNote) {
    el.settlementCompletionNote.textContent = blocked
      ? "すべての項目が完了すると、日次締めを確定できます。"
      : "締め条件を満たしています。確定前に監査ログを確認してください。";
  }
  setSettlementChecklist([
    {
      kind: openReviewCount === 0 ? "done" : "blocked",
      label: `確認待ちは ${openReviewCount}件`,
      state: openReviewCount === 0 ? "完了" : "未完了",
    },
    {
      kind: refundCandidateCount === 0 ? "done" : "blocked",
      label: `返金候補は ${refundCandidateCount}件`,
      state: refundCandidateCount === 0 ? "完了" : "未完了",
    },
    {
      kind: settlementClosed ? "done" : "warn",
      label: `${businessDate} の日次締め`,
      state: settlementClosed ? "完了" : "未実施",
    },
    {
      kind: "warn",
      label: "操作履歴を確認",
      state: "確認",
    },
    {
      kind: blocked ? "blocked" : "done",
      label: "管理者確認済み",
      state: blocked ? "未完了" : "完了",
    },
  ]);

  const totalBilled = settlement?.total_billed_jpy;
  const totalPaid = settlement?.total_paid_jpyc;
  if (el.settlementSalesText) el.settlementSalesText.textContent = totalBilled == null ? "-" : formatJpy(totalBilled);
  if (el.settlementPaidText) el.settlementPaidText.textContent = totalPaid == null ? "-" : formatJpyc(totalPaid);
  if (el.settlementRefundText) el.settlementRefundText.textContent = "-";
  if (el.settlementDeltaText) el.settlementDeltaText.textContent = totalBilled == null || totalPaid == null ? "-" : formatJpyc(Number(totalPaid) - Number(totalBilled));
  if (el.settlementPaymentCountText) el.settlementPaymentCountText.textContent = settlement?.invoice_count == null ? "-" : `${settlement.invoice_count}件`;
  if (el.settlementReviewCountText) el.settlementReviewCountText.textContent = `${openReviewCount}件`;
  if (el.settlementRefundCandidateText) el.settlementRefundCandidateText.textContent = `${refundCandidateCount}件`;
  if (el.tabBadgeSettlement) {
    el.tabBadgeSettlement.textContent = settlementClosed ? "済" : "未";
    el.tabBadgeSettlement.classList.toggle("hidden", settlementClosed === true);
  }
  renderSettlementUnresolved(openReviewCount, refundCandidateCount);
}

function renderConnectionStatus() {
  if (!el.connectionStatusPanel || !el.connectionStatusText) return;
  const sse = state.sseStatus;
  const polling = state.fallbackPollingStatus;
  let kind = "idle";
  let text = "リアルタイム更新: 未接続";
  let hint = "請求更新の受信経路を待機しています。";
  let routeText = "待機中";
  let routeTone = "s-yellow";
  if (sse === "open") {
    kind = "ok";
    text = "リアルタイム更新: 接続中";
    hint = "請求・確認状態の変更を自動で受信しています。";
    routeText = "SSE接続中";
    routeTone = "s-green";
  } else if (sse === "connecting" || sse === "reconnecting" || polling === "active") {
    kind = "warn";
    text = polling === "active" ? "リアルタイム更新: 再接続中（自動更新中）" : "リアルタイム更新: 再接続中";
    hint = polling === "active" ? "リアルタイム接続を復旧しながら、自動更新で補完しています。" : "リアルタイム接続を復旧しています。";
    routeText = polling === "active" ? "自動更新中" : "再接続中";
    routeTone = "s-yellow";
  } else if (state.token && state.invoiceId) {
    kind = "danger";
    text = "リアルタイム更新: 停止";
    hint = "請求画面を開いている間は、更新ボタンで状態を確認してください。";
    routeText = "停止";
    routeTone = "s-red";
  }
  el.connectionStatusPanel.className = `connection-status status-${kind}`;
  el.connectionStatusPanel.dataset.connectionState = kind;
  el.connectionStatusText.textContent = text;
  if (el.topbarConnectionDot) {
    el.topbarConnectionDot.className = `status-dot status-${kind}`;
  }
  if (el.connectionStatusHint) el.connectionStatusHint.textContent = hint;
  if (el.updateRouteText) {
    el.updateRouteText.className = `status-pill ${routeTone}`;
    el.updateRouteText.textContent = routeText;
  }
  if (el.apiHealthText) {
    el.apiHealthText.className = `status-pill ${state.token ? "s-green" : "s-yellow"}`;
    el.apiHealthText.textContent = state.token ? "正常" : "待機";
  }
  if (el.topbarConnectionText) el.topbarConnectionText.textContent = text.replace("リアルタイム更新: ", "");
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

function formatRemainingClock(expiresAt) {
  if (!expiresAt) return "-";
  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) return String(expiresAt);
  const remainSec = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
  const mins = Math.floor(remainSec / 60);
  const secs = remainSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")} 残り時間`;
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
  host.innerHTML = "";
  const items = Array.isArray(values) && values.length > 0 ? values : [fallback];
  for (const value of items) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = String(value || fallback);
    host.appendChild(chip);
  }
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

function parsePositiveInteger(value) {
  const normalized = String(value ?? "").replace(/[^\d]/g, "");
  if (!normalized) return 0;
  const amount = Number(normalized);
  return Number.isInteger(amount) && amount > 0 ? amount : 0;
}

function readTerminalSettings() {
  const fallback = {
    ...DEFAULT_TERMINAL_SETTINGS,
    amount_presets: [...DEFAULT_AMOUNT_PRESETS],
  };
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return {
      volume: Number.isFinite(parsed?.volume) ? parsed.volume : fallback.volume,
      brightness: Number.isFinite(parsed?.brightness) ? parsed.brightness : fallback.brightness,
      display_font_size: FONT_SIZE_OPTIONS.has(parsed?.display_font_size)
        ? parsed.display_font_size
        : fallback.display_font_size,
      auto_reset_sec: Number.isFinite(parsed?.auto_reset_sec) ? parsed.auto_reset_sec : fallback.auto_reset_sec,
      amount_presets: Object.prototype.hasOwnProperty.call(parsed || {}, "amount_presets")
        ? normalizeAmountPresetList(parsed.amount_presets)
        : fallback.amount_presets,
    };
  } catch (_error) {
    return fallback;
  }
}

function syncRangeControl(input, output) {
  if (!input) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 1);
  const value = Number(input.value || 0);
  const safeMax = max > min ? max : min + 1;
  const clamped = Math.min(Math.max(value, min), safeMax);
  const percent = ((clamped - min) / (safeMax - min)) * 100;
  input.style.setProperty("--range-progress", `${percent}%`);
  if (output) output.textContent = `${Math.round(clamped * 100)}%`;
}

function syncSettingsRangeControls() {
  syncRangeControl(el.volumeInput, el.volumePercentText);
  syncRangeControl(el.brightnessInput, el.brightnessPercentText);
}

async function playNotificationTestSound() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    showToast("この端末では通知音の再生に対応していません");
    return;
  }

  const volume = Math.min(Math.max(Number(el.volumeInput?.value || 0.8), 0), 1);
  if (volume <= 0) {
    showToast("音量が0%です。音量を上げてからテストしてください");
    return;
  }

  const audioContext = new AudioContextCtor();
  if (audioContext.state === "suspended" && typeof audioContext.resume === "function") {
    await audioContext.resume();
  }

  const startAt = audioContext.currentTime;
  const masterGain = audioContext.createGain();
  masterGain.gain.setValueAtTime(0.0001, startAt);
  masterGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.28), startAt + 0.02);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.34);
  masterGain.connect(audioContext.destination);

  const tones = [
    { frequency: 880, startOffset: 0, duration: 0.14 },
    { frequency: 1175, startOffset: 0.16, duration: 0.16 },
  ];
  for (const tone of tones) {
    const oscillator = audioContext.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(tone.frequency, startAt + tone.startOffset);
    oscillator.connect(masterGain);
    oscillator.start(startAt + tone.startOffset);
    oscillator.stop(startAt + tone.startOffset + tone.duration);
  }

  window.setTimeout(() => {
    if (typeof audioContext.close === "function") {
      void audioContext.close();
    }
  }, 600);
  showToast("通知音を再生しました");
}

function applyDisplayFontSize(size) {
  const nextSize = FONT_SIZE_OPTIONS.has(size) ? size : "standard";
  document.body.dataset.terminalFontSize = nextSize;
  for (const button of el.fontSizeButtons) {
    const isActive = button.dataset.fontSizeOption === nextSize;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

function activeDisplayFontSize() {
  const current = document.body.dataset.terminalFontSize || "standard";
  return FONT_SIZE_OPTIONS.has(current) ? current : "standard";
}

function withDisplayFontSizeParam(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set("displayFontSize", activeDisplayFontSize());
    return parsed.href;
  } catch (_error) {
    return url;
  }
}

function writeTerminalSettings(nextSettings, { showSavedToast = false } = {}) {
  const current = readTerminalSettings();
  const merged = {
    volume: Number.isFinite(nextSettings?.volume) ? Number(nextSettings.volume) : current.volume,
    brightness: Number.isFinite(nextSettings?.brightness) ? Number(nextSettings.brightness) : current.brightness,
    display_font_size: FONT_SIZE_OPTIONS.has(nextSettings?.display_font_size)
      ? nextSettings.display_font_size
      : current.display_font_size,
    auto_reset_sec: Number.isFinite(nextSettings?.auto_reset_sec)
      ? Number(nextSettings.auto_reset_sec)
      : current.auto_reset_sec,
    amount_presets: Object.prototype.hasOwnProperty.call(nextSettings || {}, "amount_presets")
      ? normalizeAmountPresetList(nextSettings.amount_presets)
      : current.amount_presets,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  if (showSavedToast) {
    showToast("端末設定を保存しました");
  }
  return merged;
}

function readCurrentTerminalSettingsForm() {
  const saved = readTerminalSettings();
  return {
    volume: Number(el.volumeInput.value || 0.8),
    brightness: Number(el.brightnessInput?.value || 0.7),
    display_font_size: document.body.dataset.terminalFontSize || "standard",
    auto_reset_sec: Number(el.autoResetSecInput.value || 120),
    amount_presets: saved.amount_presets,
  };
}

function settingsPayloadEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateSettingsSaveState() {
  const hasUnsavedChanges = !settingsPayloadEquals(readCurrentTerminalSettingsForm(), readTerminalSettings());
  for (const button of [el.saveSettingsBtn]) {
    if (!button) continue;
    button.disabled = !hasUnsavedChanges;
    button.setAttribute("aria-disabled", hasUnsavedChanges ? "false" : "true");
    button.textContent = hasUnsavedChanges ? "設定を保存" : "変更なし";
  }
  el.saveSettingsBtn?.closest(".settings-save-status")?.classList.toggle("has-unsaved-changes", hasUnsavedChanges);
}

function renderAmountPresetButtons() {
  const settings = readTerminalSettings();
  const presets = settings.amount_presets;
  el.amountPresetList.innerHTML = "";
  if (presets.length === 0) {
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

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "btn btn-ghost btn-edit";
    editButton.dataset.presetAction = "edit";
    editButton.dataset.amountPreset = String(amount);
    editButton.setAttribute("aria-label", `${formatJpy(amount)} のプリセットを編集`);
    editButton.textContent = "編集";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "btn btn-ghost btn-remove";
    removeButton.dataset.presetAction = "remove";
    removeButton.dataset.amountPreset = String(amount);
    removeButton.setAttribute("aria-label", `${formatJpy(amount)} のプリセットを削除`);
    removeButton.textContent = "×";

    chip.append(useButton, editButton, removeButton);
    el.amountPresetList.appendChild(chip);
  }
}

function setHelperLink(linkEl, href, label) {
  if (typeof href === "string" && href.trim()) {
    linkEl.href = href.trim();
    linkEl.textContent = label;
    linkEl.classList.remove("hidden");
    return;
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

function isValidIsoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function clearCountdownTimer(timerName) {
  if (!state[timerName]) return;
  clearInterval(state[timerName]);
  state[timerName] = null;
}

function clearTimeoutTimer(timerName) {
  if (!state[timerName]) return;
  clearTimeout(state[timerName]);
  state[timerName] = null;
}

function startConfirmationCountdown({ hintEl, messageForSeconds, timeoutMs, countdownTimerName, timeoutTimerName, onExpire }) {
  clearCountdownTimer(countdownTimerName);
  clearTimeoutTimer(timeoutTimerName);
  const startedAt = Date.now();
  const render = () => {
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
    const remainingSec = Math.ceil(remainingMs / 1000);
    if (hintEl) {
      hintEl.classList.remove("hidden");
      hintEl.textContent = messageForSeconds(remainingSec);
    }
  };
  render();
  state[countdownTimerName] = setInterval(render, 250);
  state[timeoutTimerName] = setTimeout(() => {
    clearCountdownTimer(countdownTimerName);
    state[timeoutTimerName] = null;
    onExpire();
  }, timeoutMs);
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

function openSettingsAdminResult(title, description) {
  if (!el.settingsAdminResultPanel) return;
  el.settingsAdminResultTitle.textContent = title;
  el.settingsAdminResultDescription.textContent = description;
  el.settingsAdminResultBody.innerHTML = "";
  el.settingsAdminResultPanel.classList.remove("hidden");
}

function toggleSettingsAdminResult(actionKey) {
  if (!el.settingsAdminResultPanel) return false;
  const isOpen = !el.settingsAdminResultPanel.classList.contains("hidden");
  if (isOpen && el.settingsAdminResultPanel.dataset.activeAdminAction === actionKey) {
    closeSettingsAdminResult();
    return false;
  }
  el.settingsAdminResultPanel.dataset.activeAdminAction = actionKey;
  return true;
}

function appendAdminResultRow(label, value, tone = "") {
  const row = document.createElement("div");
  row.className = "settings-admin-result-row";
  if (tone) row.dataset.tone = tone;
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  row.append(labelNode, valueNode);
  el.settingsAdminResultBody.appendChild(row);
}

function appendAdminResultText(text, tone = "") {
  const item = document.createElement("p");
  item.className = "settings-admin-result-text";
  if (tone) item.dataset.tone = tone;
  item.textContent = text;
  el.settingsAdminResultBody.appendChild(item);
}

function appendTerminalDiagnosticsRow(label, value, tone = "") {
  if (!el.terminalDiagnosticsBody) return;
  const row = document.createElement("div");
  row.className = "terminal-diagnostics-row";
  if (tone) row.dataset.tone = tone;
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  row.append(labelNode, valueNode);
  el.terminalDiagnosticsBody.appendChild(row);
}

function closeSettingsAdminResult() {
  if (!el.settingsAdminResultPanel) return;
  el.settingsAdminResultPanel.classList.add("hidden");
  delete el.settingsAdminResultPanel.dataset.activeAdminAction;
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
  const status = canonicalInvoiceStatus(invoice?.status) || "idle";
  const providerSummary = invoice?.provider_summary || null;
  const walletAdapter = invoice?.wallet_adapter || {};
  const reviewCaseId = invoice?.review_case_id || null;
  const supportedWallets =
    Array.isArray(invoice?.supported_wallets) && invoice.supported_wallets.length > 0
      ? invoice.supported_wallets
      : state.supportedWallets;
  const streamStatus =
    state.sseStatus === "open"
      ? "SSE 接続中"
      : state.fallbackPollingStatus === "active"
        ? "Polling fallback"
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
  const providerFallback = providerSummary?.available ? providerGuideMap[providerSummary.operator_state?.code] : null;
  const resolvedGuide = providerFallback || fallback;
  const actionPolicy = getOperatorActionPolicy(providerFallback ? "review_required" : status);
  if (providerFallback) {
    renderChipGroup(el.operatorWalletChips, [
      providerSummary.provider_code || "店頭端末連携",
      providerSummary.payment_session_status || "presented",
    ], "店頭端末連携");
    el.operatorWalletHelpLink.classList.add("hidden");
    el.operatorWalletHelpLink.removeAttribute("href");
  } else {
    renderChipGroup(el.operatorWalletChips, supportedWallets, walletAdapter.reason ? "手動送金案内" : "ウォレット確認待ち");
    setHelperLink(el.operatorWalletHelpLink, invoice?.wallet_help_url || "", "お客様向けウォレット案内を開く");
  }

  if (!el.operatorGuideList) return;
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
  el.operatorGuideList.innerHTML = "";
  const actionItems = providerFallback
    ? resolvedGuide.items.slice(0, 3)
    : [actionPolicy.handoff, actionPolicy.next, actionPolicy.manager];
  for (const item of actionItems) {
    const li = document.createElement("li");
    li.textContent = item;
    el.operatorGuideList.appendChild(li);
  }
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
      action: "金額が不足しています。追加支払い案内か会計修正のどちらにするか管理者確認で決めてください。",
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
  return {
    action: "取引番号と請求内容を確認し、必要なら in_progress にして担当者メモを残してください。",
    refundHint: "返金要否は明細確認後に判断してください。",
    suggestedRefundAmount: null,
    suggestedNextStatus: review.status === "open" ? "in_progress" : review.status,
    priorityLabel: priority.label,
  };
}

async function loadOpsSnapshot() {
  if (!isAdminRole(state.role)) return;
  const businessDate = isValidIsoDate(String(el.businessDateInput.value || "").trim())
    ? String(el.businessDateInput.value || "").trim()
    : nowIsoDate();
  el.opsSnapshotState.textContent = "運用サマリーを更新中です。";
  try {
    const [reviewsResult, settlementResult, monitorResult] = await Promise.allSettled([
      requestJson("/api/v1/reviews"),
      requestJson(`/api/v1/settlements/daily-status?business_date=${encodeURIComponent(businessDate)}`),
      requestJson("/api/v1/chain-monitor/status"),
    ]);
    const failedSources = [
      reviewsResult.status === "rejected" ? "確認待ち" : "",
      settlementResult.status === "rejected" ? "締め状態" : "",
      monitorResult.status === "rejected" ? "監視状態" : "",
    ].filter(Boolean);

    const reviews = reviewsResult.status === "fulfilled" && Array.isArray(reviewsResult.value.reviews)
      ? [...reviewsResult.value.reviews]
      : [];
    const sortedReviews = reviews.sort(compareReviewsByPriority);
    const activeReviews = sortedReviews.filter((row) => ["open", "in_progress"].includes(String(row.status || "")));
    const openReviewCount = activeReviews.length;
    const priorityReview = activeReviews[0] || null;
    const refundCandidateCount = activeReviews.filter((row) => isRefundCandidateReason(row.reason_type)).length;

    const monitor = monitorResult.status === "fulfilled" ? monitorResult.value : null;
    const pendingDead = monitor ? Number(monitor.pending_dead_letter_count || 0) : null;
    const abandonedDead = monitor ? Number(monitor.abandoned_dead_letter_count || 0) : null;
    const unmatchedCount = monitor ? Number(monitor.unmatched_event_count || 0) : null;
    const failoverCount = monitor ? Number(monitor.failover_count || 0) : null;
    const deadLabel =
      pendingDead == null || abandonedDead == null
        ? "取得失敗"
        : `${pendingDead + abandonedDead}件`;

    const settlementClosed = settlementResult.status === "fulfilled" ? settlementResult.value.closed === true : null;
    const settlement = settlementResult.status === "fulfilled" ? settlementResult.value?.settlement || null : null;
    const settlementReviewCount = settlementResult.status === "fulfilled"
      ? Number(settlement?.review_count || 0)
      : null;

    renderOpsWarningsList(monitor ? buildMonitorWarnings(monitor) : ["監視状態を取得できませんでした"]);

    const addressPoolCount = monitor != null ? Number(monitor.address_pool_available_count ?? -1) : null;
    const monitorStateRows = Array.isArray(monitor?.state) ? monitor.state : [];
    const workerStaleSec = monitor ? detectWorkerStaleSec(monitorStateRows) : null;
    let workerStatusText;
    if (!monitor) {
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

    if (abandonedDead != null && abandonedDead > 0) {
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
      addressPoolCount != null && addressPoolCount >= 0
        ? `${addressPoolCount}件${addressPoolCount <= ADDRESS_POOL_WARN_THRESHOLD ? "（要補充）" : ""}`
        : "取得失敗";
    el.opsWorkerStatus.textContent = workerStatusText || "-";

    el.opsOpenReviewCount.textContent = `${openReviewCount}件`;
    if (el.topbarOpenReviewCount) el.topbarOpenReviewCount.textContent = `${openReviewCount}件`;
    el.opsDeadLetterCount.textContent = deadLabel;
    el.opsSettlementStatus.textContent =
      settlementClosed == null
        ? "取得失敗"
        : settlementClosed
          ? settlementReviewCount && settlementReviewCount > 0
            ? `完了（要確認 ${settlementReviewCount}件）`
            : "完了"
          : "未実施";
    el.opsRecommendedAction.textContent = recommendedAction;
    el.opsPriorityReview.textContent = priorityReview
      ? `${reviewReasonLabel(priorityReview.reason_type)} / ${shortId(priorityReview.id)}`
      : "なし";
    el.opsRefundCandidateCount.textContent = `${refundCandidateCount}件`;
    renderTopbarRefundSummary(openReviewCount, refundCandidateCount);
    renderSettlementDashboard({
      businessDate,
      settlementClosed,
      settlement,
      openReviewCount,
      refundCandidateCount,
    });
    setLastUpdated(el.settlementLastUpdatedText);
    setLastUpdated(el.refundsLastUpdatedText);
    el.opsSnapshotState.textContent = failedSources.length > 0
      ? `一部の運用情報を取得できませんでした: ${failedSources.join("、")}。表示中の値は取得できた情報だけで更新しています。`
      : "小規模店舗の現場で、いま止まりやすい項目を review / refund / settlement / monitor で優先表示しています。";
    setChecklist(el.opsSnapshotChecklist, checklist);
  } catch (_error) {
    el.opsOpenReviewCount.textContent = "-";
    el.opsDeadLetterCount.textContent = "-";
    el.opsSettlementStatus.textContent = "-";
    el.opsRecommendedAction.textContent = "再取得";
    el.opsPriorityReview.textContent = "-";
    el.opsRefundCandidateCount.textContent = "-";
    el.opsAddressPoolCount.textContent = "-";
    el.opsWorkerStatus.textContent = "-";
    renderTopbarRefundSummary(0, 0);
    renderSettlementDashboard({
      businessDate,
      settlementClosed: null,
      settlement: null,
      openReviewCount: 0,
      refundCandidateCount: 0,
    });
    if (el.settlementBlockerTitle) el.settlementBlockerTitle.textContent = "締め前チェック取得失敗";
    if (el.settlementBlockerReason) el.settlementBlockerReason.textContent = "締め状態または運用サマリーを取得できませんでした。";
    if (el.settlementBlockerNext) el.settlementBlockerNext.textContent = "通信状態と権限を確認してから再取得してください。";
    if (el.tabBadgeSettlement) {
      el.tabBadgeSettlement.textContent = "!";
      el.tabBadgeSettlement.classList.remove("hidden");
    }
    setLastUpdated(el.settlementLastUpdatedText);
    el.opsSnapshotState.textContent = "運用サマリーの取得に失敗しました。";
    renderOpsWarningsList(["監視状態を取得できませんでした"]);
    setChecklist(el.opsSnapshotChecklist, ["ネットワークまたは権限状態を確認してから再取得してください。"]);
  }
}

function startOpsAutoRefresh() {
  if (state.autoRefreshTimer !== null) return;
  state.autoRefreshTimer = setInterval(() => {
    if (isAdminRole(state.role)) void loadOpsSnapshot();
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
  renderOperatorGuide();
}

function setFallbackPollingStatus(status, reason = "") {
  state.fallbackPollingStatus = status;
  state.fallbackPollingReason = reason || "";
  state.fallbackPollingUpdatedAt = nowIso();
  renderConnectionStatus();
  renderDiagnostics();
  renderOperatorGuide();
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

function showToast(message, isError = false) {
  el.toastHost.querySelectorAll(".toast").forEach((node) => node.remove());
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.className = `toast ${isError ? "toast-error" : "toast-info"}`;
  el.toastHost.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 5000);
}

function setLoggedInUi(loggedIn) {
  document.body.classList.toggle("is-terminal-logged-in", loggedIn);
  if (!loggedIn && state.activeTab !== "billing") {
    setActiveTab("billing");
  }
  if (el.loginStartPanel) el.loginStartPanel.classList.toggle("hidden", loggedIn);
  if (el.terminalTabNav) el.terminalTabNav.classList.toggle("hidden", !loggedIn);
  if (el.terminalWorkspace) el.terminalWorkspace.classList.toggle("hidden", !loggedIn);
  if (el.loginFormPanel) el.loginFormPanel.classList.toggle("collapsed-after-login", loggedIn);
  if (el.staffPinConfirmLabel) el.staffPinConfirmLabel.classList.add("hidden");
}

function resetTerminalSessionUi(message) {
  closeSse("セッション終了");
  stopFallbackPolling();
  stopOpsAutoRefresh();
  state.token = "";
  state.terminalId = "";
  state.storeId = "";
  state.sessionId = "";
  state.role = "";
  state.storeName = "";
  state.staffName = "";
  state.supportedWallets = [];
  state.fixedQrUrl = "";
  state.fixedQrToken = "";
  state.diagnosticsEnabled = false;
  clearInvoiceView();
  setLoggedInUi(false);
  applyAdminVisibility();
  renderTopbarRole();
  renderSettingsSessionSummary();
  if (el.sessionText) el.sessionText.textContent = "未接続";
  if (el.sessionExpiryText) el.sessionExpiryText.textContent = "-";
  if (el.topbarOpenReviewCount) el.topbarOpenReviewCount.textContent = "-";
  renderTopbarRefundSummary(0, 0);
  setNetworkStatus("未接続");
  renderDiagnostics();
  renderOperatorGuide();
  if (message) showToast(message);
}

function handleLockTerminal() {
  resetTerminalSessionUi("端末をロックしました。再開するにはPINでログインしてください");
}

async function handleLogoutTerminal() {
  if (!state.token) {
    resetTerminalSessionUi("ログアウトしました");
    return;
  }
  if (el.logoutTerminalBtn) el.logoutTerminalBtn.disabled = true;
  try {
    await requestJson("/api/v1/terminal-sessions/current", {
      method: "DELETE",
      headers: {
        "idempotency-key": idempotencyKey("session-logout"),
      },
    });
    resetTerminalSessionUi("ログアウトしました");
  } catch (error) {
    showToast(String(error.message || error), true);
  } finally {
    if (el.logoutTerminalBtn) el.logoutTerminalBtn.disabled = false;
  }
}

function setRefundStepIndicators(stepName) {
  const order = ["request", "approve", "evidence", "verify"];
  const nodes = {
    request: el.refundStepRequestIndicator,
    approve: el.refundStepApproveIndicator,
    evidence: el.refundStepEvidenceIndicator,
    verify: el.refundStepVerifyIndicator,
  };
  const activeIndex = Math.max(0, order.indexOf(stepName));
  for (const [index, key] of order.entries()) {
    const node = nodes[key];
    if (!node) continue;
    node.classList.toggle("is-current", index === activeIndex);
    node.classList.toggle("is-complete", index < activeIndex);
    node.toggleAttribute("aria-current", index === activeIndex);
  }
  document.querySelectorAll(".refund-form-stack .step-panel").forEach((panel, index) => {
    panel.dataset.stepState = index < activeIndex ? "complete" : index === activeIndex ? "current" : "locked";
  });
}

function updateRefundSummary() {
  const amount = Number(el.refundAmount?.value || 0);
  if (el.refundSummaryAmount) el.refundSummaryAmount.textContent = Number.isFinite(amount) && amount > 0 ? formatJpyc(amount) : "-";
  const address = String(el.refundAddress?.value || "").trim();
  if (el.refundSummaryAddress) el.refundSummaryAddress.textContent = address || "未入力";
}

function updateRefundEvidencePathHint() {
  if (!el.refundEvidencePathHint) return;
  const value = String(el.refundEvidenceNotePathInput?.value || "");
  el.refundEvidencePathHint.textContent = value === "docs/production/evidence/refunds/not-attached-yet"
    ? "後で添付する場合は、返金IDと取引番号を控えてから管理PCまたは台帳の証跡欄に追記してください。"
    : "証跡の保管先を選んでください。";
}

function updateRefundStepState(statusText = "") {
  const hasRefundId = Boolean(String(el.refundIdInput?.value || "").trim());
  const hasTx = Boolean(String(el.refundTxHashInput?.value || "").trim());
  const normalizedStatus = String(statusText || "").toLowerCase();
  const workflowStatus = state.refundWorkflowStatus || "draft";
  const stepName = normalizedStatus.includes("検証済") || normalizedStatus === "succeeded" || workflowStatus === "verified"
    ? "verify"
    : workflowStatus === "approved" || workflowStatus === "recorded" || hasTx
      ? "evidence"
      : hasRefundId || workflowStatus === "requested" || workflowStatus === "approved"
        ? "approve"
        : "request";
  if (el.refundStepRequestBadge) el.refundStepRequestBadge.textContent = hasRefundId ? "作成済み" : "入力";
  if (el.refundStepApproveBadge) el.refundStepApproveBadge.textContent = hasRefundId ? "承認待ち" : "返金ID待ち";
  if (el.refundStepEvidenceBadge) el.refundStepEvidenceBadge.textContent = statusText || (hasRefundId ? "証跡入力" : "返金ID待ち");
  if (el.approveRefundBtn) el.approveRefundBtn.disabled = !hasRefundId || ["approved", "recorded", "verified"].includes(workflowStatus);
  if (el.executeRefundBtn) el.executeRefundBtn.disabled = workflowStatus !== "approved";
  if (el.verifyRefundBtn) el.verifyRefundBtn.disabled = workflowStatus !== "recorded";
  setRefundStepIndicators(stepName);
  updateRefundSummary();
  updateRefundEvidencePathHint();
}

const STOP_QR_REASON_META = Object.freeze({
  amount_mistake: { label: "金額ミス", actionPath: "cancel" },
  payment_method_changed: { label: "支払い方法変更", actionPath: "cancel" },
  customer_cancelled: { label: "お客様キャンセル", actionPath: "cancel" },
  time_expired: { label: "時間切れ", actionPath: "expire" },
  reissue_invoice: { label: "新しい請求を出す", actionPath: "cancel" },
});

function getSelectedStopQrReason() {
  const reason = String(el.stopQrReasonSelect?.value || "amount_mistake");
  return STOP_QR_REASON_META[reason] || STOP_QR_REASON_META.amount_mistake;
}

function confirmStopQrAction() {
  if (["cancelled", "expired"].includes(state.invoiceStatus)) {
    clearInvoiceView();
    return;
  }
  const reasonMeta = getSelectedStopQrReason();
  confirmDangerInvoiceAction(reasonMeta.actionPath, "QR停止", `理由: ${reasonMeta.label}`);
}

function confirmDangerInvoiceAction(actionPath, label, detail = "") {
  if (!state.invoiceId) {
    showToast("対象の請求がありません", true);
    return;
  }
  const dangerHintEl = el.stopQrConfirmHint || el.amountInputError;
  const pendingKey = `${actionPath}:${detail}`;
  const detailText = detail ? `（${detail}）` : "";
  if (state.pendingDangerAction !== pendingKey) {
    state.pendingDangerAction = pendingKey;
    if (dangerHintEl && dangerHintEl !== el.amountInputError) el.amountInputError.textContent = "";
    showToast(`${label}するには、${Math.ceil(INVOICE_DANGER_CONFIRM_MS / 1000)}秒以内に同じボタンをもう一度押してください${detailText}`, true);
    startConfirmationCountdown({
      hintEl: dangerHintEl,
      timeoutMs: INVOICE_DANGER_CONFIRM_MS,
      countdownTimerName: "pendingDangerCountdownTimer",
      timeoutTimerName: "pendingDangerTimer",
      messageForSeconds: (remainingSec) => `あと${remainingSec}秒以内にもう一度押すと${label}します。${detailText}`,
      onExpire: () => {
        if (state.pendingDangerAction === pendingKey) {
          state.pendingDangerAction = "";
          dangerHintEl.textContent = `${label}の確認は時間切れです。必要ならもう一度押してください。`;
        }
      },
    });
    return;
  }
  state.pendingDangerAction = "";
  clearCountdownTimer("pendingDangerCountdownTimer");
  clearTimeoutTimer("pendingDangerTimer");
  if (dangerHintEl) dangerHintEl.textContent = "";
  void postInvoiceAction(actionPath, `${label}しました${detailText}`);
}

const ERROR_MESSAGE_BY_CODE = {
  ADDRESS_POOL_EXHAUSTED: "請求に使える受取アドレスがありません。店長またはサポートに確認してください。",
  AML_POLICY_NOT_APPROVED: "高額請求は承認が完了するまで作成できません。店長またはサポートに確認してください。",
  DAILY_STORE_AMOUNT_CAP_EXCEEDED: "本日の店舗上限額を超えています。店長またはサポートに確認してください。",
  DAILY_STORE_INVOICE_CAP_EXCEEDED: "本日の請求作成上限を超えています。店長またはサポートに確認してください。",
  DUPLICATE_REFUND_TX_HASH: "この返金取引番号はすでに別の返金記録で使われています。",
  INVALID_STATE_TRANSITION: "現在の状態ではこの操作を実行できません。画面を更新して状態を確認してください。",
  NOT_FOUND: "対象データが見つかりません。画面を更新して確認してください。",
  PAYMENTS_DISABLED: "現在、新しい請求の作成は一時停止されています。",
  STORE_PAYMENTS_DISABLED: "この店舗では新しい請求の作成が一時停止されています。",
  TERMINAL_PAYMENTS_DISABLED: "この端末では新しい請求の作成が一時停止されています。",
  TWO_PERSON_REQUIRED: "この操作は別の管理者による承認または実行が必要です。",
  VALIDATION_ERROR: "入力内容を確認してください。",
};

function parseErrorMessage(data, fallback = "リクエストに失敗しました") {
  const code = String(data?.error?.code || "");
  if (ERROR_MESSAGE_BY_CODE[code]) return ERROR_MESSAGE_BY_CODE[code];
  const serverMessage = String(data?.error?.message || "");
  return /[ぁ-んァ-ン一-龯]/.test(serverMessage) ? serverMessage : fallback;
}

function authHeaders() {
  if (!state.token) return {};
  return { authorization: `Bearer ${state.token}` };
}

async function requestJson(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
    ...authHeaders(),
  };
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = parseErrorMessage(payload);
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function requestText(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
    ...authHeaders(),
  };
  const response = await fetch(path, { ...options, headers });
  const body = await response.text();
  if (!response.ok) {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch (_error) {
      payload = {};
    }
    const message = parseErrorMessage(payload, body || "リクエストに失敗しました");
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return { body, headers: response.headers };
}

function setInvoiceStatusPill(statusRaw) {
  const status = canonicalInvoiceStatus(statusRaw);
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

function invoiceStatusMeta(statusRaw) {
  const status = canonicalInvoiceStatus(statusRaw);
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
  return { label, klass };
}

function clearQr() {
  const ctx = el.qrCanvas.getContext("2d");
  ctx.clearRect(0, 0, el.qrCanvas.width, el.qrCanvas.height);
  ctx.fillStyle = "#f4f6fb";
  ctx.fillRect(0, 0, el.qrCanvas.width, el.qrCanvas.height);
  ctx.fillStyle = "#5a6a82";
  ctx.font = "16px sans-serif";
  ctx.fillText("QRなし", 16, 30);
}

function drawQr(value) {
  if (!value || typeof qrcode !== "function") {
    clearQr();
    return;
  }
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const ctx = el.qrCanvas.getContext("2d");
  const size = Math.min(el.qrCanvas.width, el.qrCanvas.height);
  const tile = size / moduleCount;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#132036";
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qr.isDark(row, col)) {
        const x = Math.round(col * tile);
        const y = Math.round(row * tile);
        const w = Math.ceil((col + 1) * tile) - x;
        const h = Math.ceil((row + 1) * tile) - y;
        ctx.fillRect(x, y, w, h);
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
  const tapOnly = providerSummary?.qr_available === false;
  el.qrCanvas.classList.toggle("hidden", tapOnly);
  el.tapModePanel.classList.toggle("hidden", !tapOnly);
  if (!tapOnly) {
    if (state.fixedQrUrl) {
      const fixedQrUrl = withDisplayFontSizeParam(state.fixedQrUrl);
      drawQr(fixedQrUrl);
      el.fixedQrUrlLink.textContent = fixedQrUrl;
      el.fixedQrUrlLink.href = fixedQrUrl;
    } else {
      el.fixedQrUrlLink.textContent = "-";
      el.fixedQrUrlLink.removeAttribute("href");
      clearQr();
    }
    return;
  }

  el.tapModeBadge.textContent = providerSummary.operator_state?.label || "タッチ案内";
  el.tapModeBadge.className = `status-pill ${providerBadgeClass(providerSummary.operator_state?.code)}`;
  el.tapModeTitle.textContent = providerSummary.customer_payment_mode?.title || "カード・スマホをかざしてください";
  el.tapModeBody.textContent =
    providerSummary.customer_payment_mode?.body || providerSummary.operator_state?.body || "店頭端末でタッチ決済をご案内しています。";
  el.tapModeAmount.textContent = formatJpy(invoice?.amounts?.amount_jpy || 0);
}

function renderCustomerFacingQr() {
  renderCustomerFacingDisplay(state.currentInvoice);
}

function stopFallbackPolling() {
  if (state.fallbackPollTimer) {
    clearInterval(state.fallbackPollTimer);
    state.fallbackPollTimer = null;
  }
  setFallbackPollingStatus("idle", "停止中");
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
  if (!state.invoiceId || !ACTIVE_INVOICE_STATUSES.has(state.invoiceStatus)) {
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
  const providerSummary = invoice?.provider_summary || null;
  const isMockRail = providerSummary?.available === true && providerSummary?.provider_code === "mock_provider";
  el.presentTapBtn.classList.toggle("is-preview", isMockRail);
  if (!providerSummary?.available) {
    el.providerOperatorStateText.textContent = "QR案内";
    el.providerStatusText.textContent = "店頭端末未提示";
    if (el.providerControlHint) {
      el.providerControlHint.textContent = "タッチ決済の連携は現在の運用スコープ外です。お客様にはQRでご案内してください。";
    }
    el.presentTapBtn.disabled = true;
    if (el.resumeQrBtn) el.resumeQrBtn.disabled = true;
    return;
  }

  el.providerOperatorStateText.textContent = providerSummary.operator_state?.label || "-";
  el.providerStatusText.textContent =
    [
      providerSummary.payment_session_status || null,
      providerSummary.provider_status || null,
      providerSummary.fulfillment_decision === "allow_fulfillment" ? "allow_fulfillment" : null,
    ].filter(Boolean).join(" / ") || "-";
  if (el.providerControlHint) {
    el.providerControlHint.textContent = providerSummary.qr_available
      ? "QR案内に戻っています。必要なら改めて tap を提示できます。"
      : (providerSummary.operator_state?.body || "タッチ案内中は端末入口QR導線を止め、同じ会計の二重導線を防ぎます。");
  }
  el.presentTapBtn.disabled = providerSummary.can_present !== true;
  if (el.resumeQrBtn) el.resumeQrBtn.disabled = providerSummary.can_cancel_presentation !== true;
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

function updateAmountPreview() {
  if (!el.amountJpycPreview) return;
  const amount = Number(el.amountInput?.value || 0);
  if (!Number.isInteger(amount) || amount <= 0) {
    el.amountJpycPreview.textContent = "= 金額を入力してください";
    if (!state.invoiceId && el.amountCompareDelta) el.amountCompareDelta.textContent = "未発行";
    return;
  }
  el.amountJpycPreview.textContent = `= ${formatJpyc(amount)}`;
  if (!state.invoiceId && el.amountComparePaid) el.amountComparePaid.textContent = "0 JPYC";
  if (!state.invoiceId && el.amountCompareDelta) el.amountCompareDelta.textContent = "請求未発行";
}

function setBillingInvoicePresence(hasInvoice) {
  el.billingCurrentPanel?.closest(".billing-left")?.classList.toggle("has-current-invoice", hasInvoice);
  el.billingCurrentPanel?.classList.toggle("is-empty", !hasInvoice);
  el.billingCurrentPanel?.classList.toggle("is-draft", !hasInvoice);
  el.billingCurrentPanel?.classList.toggle("is-issued", hasInvoice);
  el.billingCurrentEmptyHint?.classList.toggle("hidden", hasInvoice);
  el.paymentUrlRow?.classList.toggle("hidden", !hasInvoice);
  if (el.amountInput) el.amountInput.disabled = hasInvoice;
}

function renderHandoverNote(invoiceStatus) {
  if (!el.handoverNote) return;
  if (invoiceStatus === "paid" || invoiceStatus === "settled") {
    el.handoverNote.textContent = "🟢 商品を渡してよいか: 支払い確認済みです。通常の引き渡し手順へ進めます。";
    el.handoverNote.className = "ops-note handover-ok";
    return;
  }
  if (invoiceStatus === "review_required") {
    el.handoverNote.textContent = "🔴 商品を渡してよいか: 管理者確認が終わるまで、商品はまだ渡さないでください。";
    el.handoverNote.className = "ops-note handover-admin";
    return;
  }
  el.handoverNote.textContent = "🟡 商品を渡してよいか: お支払いを確認するまで、商品はまだ渡さないでください。";
  el.handoverNote.className = "ops-note handover-wait";
}

function renderInvoice(invoice) {
  const previousInvoiceId = state.invoiceId;
  state.currentInvoice = invoice;
  state.invoiceDiagnostics = invoice.diagnostics || null;
  state.invoiceId = invoice.invoice_id || "";
  const invoiceStatus = canonicalInvoiceStatus(invoice.status);
  state.invoiceStatus = invoiceStatus;
  if (invoice.chain?.chain_id || invoice.chain_id || invoice.payment_chain?.chain_id) {
    state.selectedPaymentChainId = String(invoice.payment_chain?.chain_id || invoice.chain?.chain_id || invoice.chain_id);
  }
  setBillingInvoicePresence(true);
  setInvoiceStatusPill(invoiceStatus);
  if (el.billingWaitingPill) {
    const meta = invoiceStatusMeta(invoiceStatus);
    el.billingWaitingPill.textContent = invoiceStatus === "paid"
      ? "支払い完了"
      : ACTIVE_INVOICE_STATUSES.has(invoiceStatus)
        ? "支払い待ち"
        : meta.label;
    el.billingWaitingPill.className = `status-pill ${meta.klass}`;
  }
  el.invoiceIdText.textContent = invoice.invoice_no || shortId(invoice.invoice_id || "", 10, 5) || "-";
  if (invoice.payment_url) {
    const paymentUrl = withDisplayFontSizeParam(invoice.payment_url);
    el.paymentUrlLink.textContent = paymentUrl;
    el.paymentUrlLink.href = paymentUrl;
  } else {
    el.paymentUrlLink.textContent = "-";
    el.paymentUrlLink.removeAttribute("href");
  }
  el.expiresAtText.textContent = formatRemainingClock(invoice.expires_at);
  el.amountText.textContent = `${invoice.amounts?.amount_jpyc_display ?? "-"} JPYC`;
  el.paidText.textContent = `${invoice.amounts?.paid_amount_jpyc_display ?? "-"} JPYC`;
  const selectedChainMeta = invoice.payment_chain || invoice.chain || selectedPaymentChain() || {};
  const selectedChainId = selectedChainMeta.chain_id || invoice.chain_id || "-";
  const selectedNetwork = selectedChainMeta.network || chainLabel(selectedChainId);
  if (el.paymentChainText) el.paymentChainText.textContent = `${selectedNetwork} / Chain ID ${selectedChainId}`;
  if (el.paymentContractText) {
    el.paymentContractText.textContent = selectedChainMeta.token_contract_display
      || invoice.token_contract
      || selectedChainMeta.token_contract
      || OFFICIAL_JPYC_CONTRACT_DISPLAY;
  }
  if (ACTIVE_INVOICE_STATUSES.has(invoiceStatus) && invoice.amount_jpy != null) {
    el.amountInput.value = String(invoice.amount_jpy);
    updateAmountPreview();
  }
  renderAmountCompare(invoice);
  renderHandoverNote(invoiceStatus);
  if (el.qrAccessibleText) {
    el.qrAccessibleText.textContent =
      `決済QR。請求ID ${invoice.invoice_no || invoice.invoice_id || "-"}、請求額 ${invoice.amounts?.amount_jpyc_display ?? "-"} JPYC。`;
  }
  el.reasonText.textContent = invoice.status_reason || "-";
  renderProviderControls(invoice);
  renderCustomerFacingQr();
  el.createInvoiceBtn.textContent = "＋ 請求を作成";
  if (el.cancelInvoiceBtn) {
    el.cancelInvoiceBtn.textContent = ["cancelled", "expired"].includes(invoiceStatus) ? "もう一度請求作成" : "QR停止";
  }
  el.createInvoiceBtn.disabled = ACTIVE_INVOICE_STATUSES.has(invoiceStatus);
  el.createInvoiceBtn.title = ACTIVE_INVOICE_STATUSES.has(invoiceStatus)
    ? "現在の会計が残っています。再発行またはQR停止後に新規会計を開始してください。"
    : "";

  if (state.terminalId && ACTIVE_INVOICE_STATUSES.has(invoiceStatus) && (!state.sse || previousInvoiceId !== state.invoiceId)) {
    void connectTerminalStream();
  }
  if (FINAL_INVOICE_STATUSES.has(invoiceStatus)) {
    closeSse();
  }
  if (state.sseStatus !== "open") startFallbackPollingIfNeeded();
  renderDiagnostics();
  renderOperatorGuide();
  renderPaymentChains();
  renderConnectionStatus();
}

function clearInvoiceView() {
  state.invoiceId = "";
  state.invoiceStatus = "";
  state.currentInvoice = null;
  state.invoiceDiagnostics = null;
  state.selectedReviewId = "";
  state.selectedReviewDetail = null;
  state.sseToken = "";
  setBillingInvoicePresence(false);
  setInvoiceStatusPill("");
  if (el.billingWaitingPill) {
    el.billingWaitingPill.textContent = "未発行";
    el.billingWaitingPill.className = "status-pill s-gray";
  }
  el.invoiceIdText.textContent = "-";
  el.paymentUrlLink.textContent = "-";
  el.paymentUrlLink.removeAttribute("href");
  el.expiresAtText.textContent = "-";
  el.amountText.textContent = "-";
  el.paidText.textContent = "-";
  if (el.paymentChainText) el.paymentChainText.textContent = "-";
  if (el.paymentContractText) el.paymentContractText.textContent = "-";
  if (el.stopQrConfirmHint) el.stopQrConfirmHint.textContent = "";
  renderAmountCompare(null);
  if (el.amountComparePaid) el.amountComparePaid.textContent = "0 JPYC";
  if (el.amountCompareDelta) el.amountCompareDelta.textContent = "請求未発行";
  updateAmountPreview();
  renderHandoverNote("");
  if (el.qrAccessibleText) el.qrAccessibleText.textContent = "請求IDと金額は現在の請求欄に表示されます。";
  el.reasonText.textContent = "-";
  el.providerOperatorStateText.textContent = "-";
  el.providerStatusText.textContent = "-";
  if (el.providerControlHint) {
    el.providerControlHint.textContent = "QR とタッチ案内は同じ会計で同時に開きません。タッチ案内中は端末入口QRからのウォレット導線を止めます。";
  }
  el.presentTapBtn.disabled = true;
  el.createInvoiceBtn.disabled = false;
  el.createInvoiceBtn.textContent = "＋ 請求を作成";
  el.createInvoiceBtn.removeAttribute("title");
  if (el.cancelInvoiceBtn) el.cancelInvoiceBtn.textContent = "QR停止";
  if (el.resumeQrBtn) el.resumeQrBtn.disabled = true;
  renderCustomerFacingQr();
  closeSse("未接続");
  stopFallbackPolling();
  setFallbackPollingStatus("idle", "未開始");
  renderDiagnostics();
  renderOperatorGuide();
  renderPaymentChains();
  renderConnectionStatus();
}

async function loadInvoice(invoiceId, options = {}) {
  if (!invoiceId) return;
  try {
    const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(invoiceId)}`);
    state.lastInvoiceRefreshAt = nowIso();
    renderInvoice(data);
    if (!options.silent) {
      showToast(`請求状態を更新しました（${el.invoiceStatusPill.textContent}）`);
    }
  } catch (error) {
    if (!options.silent) showToast(String(error.message || error), true);
  }
}

function applyAmountPreset(amount) {
  const addAmount = Number(amount);
  if (!Number.isInteger(addAmount) || addAmount <= 0) {
    showToast("プリセット金額を読み取れませんでした", true);
    return;
  }
  const currentAmount = parsePositiveInteger(el.amountInput.value);
  const nextAmount = currentAmount + addAmount;
  el.amountInput.value = String(nextAmount);
  el.amountInputError.textContent = "";
  updateAmountPreview();
  showToast(`${formatJpy(addAmount)} を追加して ${formatJpy(nextAmount)} にしました`);
}

function handleAddAmountPreset() {
  const amount = parsePositiveInteger(el.presetAmountInput.value);
  if (!Number.isInteger(amount) || amount <= 0) {
    showToast("追加する金額は 1円以上の整数で入力してください", true);
    return;
  }
  const current = readTerminalSettings();
  if (current.amount_presets.includes(amount)) {
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

function handleEditAmountPreset(amount) {
  const numericAmount = Number(amount);
  const current = readTerminalSettings();
  if (!current.amount_presets.includes(numericAmount)) {
    showToast("編集するプリセットが見つかりません", true);
    return;
  }
  const input = window.prompt("プリセット金額を変更", String(numericAmount));
  if (input == null) return;
  const nextAmount = parsePositiveInteger(input);
  if (!Number.isInteger(nextAmount) || nextAmount <= 0) {
    showToast("金額は 1円以上の整数で入力してください", true);
    return;
  }
  if (nextAmount !== numericAmount && current.amount_presets.includes(nextAmount)) {
    showToast("その金額はすでにプリセットにあります", true);
    return;
  }
  const nextPresets = current.amount_presets.map((value) => (value === numericAmount ? nextAmount : value));
  writeTerminalSettings({ amount_presets: nextPresets });
  renderAmountPresetButtons();
  showToast(`${formatJpy(numericAmount)} を ${formatJpy(nextAmount)} に変更しました`);
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

function setRefundCaseFilter(filterValue) {
  const nextFilter = String(filterValue || "all");
  const filterButtons = Array.from(document.querySelectorAll("[data-refund-filter]"));
  const caseCards = Array.from(document.querySelectorAll(".refund-case-card[data-refund-status]"));

  for (const button of filterButtons) {
    const isActive = button.dataset.refundFilter === nextFilter;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }

  let firstVisible = null;
  for (const card of caseCards) {
    const matches = nextFilter === "all" || card.dataset.refundStatus === nextFilter;
    card.classList.toggle("hidden", !matches);
    if (matches && !firstVisible) firstVisible = card;
  }

  const activeVisible = caseCards.some((card) => card.classList.contains("is-active") && !card.classList.contains("hidden"));
  if (!activeVisible && firstVisible) {
    caseCards.forEach((card) => card.classList.remove("is-active"));
    firstVisible.classList.add("is-active");
  }
}

async function copyPaymentUrl() {
  const href = el.paymentUrlLink?.href || "";
  const text = href && href !== window.location.href ? href : "";
  if (!text) {
    showToast("コピーできる支払いURLがありません", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("支払いURLをコピーしました");
  } catch (_error) {
    showToast("このブラウザでは自動コピーできません。URLを手動で選択してください。", true);
  }
}

async function fetchSseToken(invoiceId) {
  const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(invoiceId)}/sse-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  state.sseToken = data.token;
  return data.token;
}

async function connectTerminalStream() {
  if (!state.token || !state.terminalId || !state.invoiceId) return;
  const invoiceId = state.invoiceId;
  closeSse();
  let sseToken = "";
  setSseStatus("connecting", "SSE token を取得中");
  try {
    sseToken = await fetchSseToken(invoiceId);
  } catch (error) {
    setNetworkStatus("再接続中（トークン取得失敗）");
    setSseStatus("reconnecting", "トークン取得失敗");
    startFallbackPollingIfNeeded();
    scheduleSseReconnect();
    return;
  }
  if (state.invoiceId !== invoiceId) return;

  const streamUrl =
    `/api/v1/streams/terminals/${encodeURIComponent(state.terminalId)}` +
    `?invoice_id=${encodeURIComponent(invoiceId)}&sse_token=${encodeURIComponent(sseToken)}`;

  state.sse = new EventSource(streamUrl);

  state.sse.addEventListener("open", () => {
    setNetworkStatus("リアルタイム接続中");
    setSseStatus("open", "SSE 接続済み");
    stopFallbackPolling();
    state.lastStreamEventAt = nowIso();
    if (state.invoiceId) {
      void loadInvoice(state.invoiceId, { silent: true });
    }
  });

  const refreshFromStream = (event) => {
    try {
      const payload = JSON.parse(event.data || "{}");
      const updatedInvoiceId = payload.invoiceId || payload.invoice_id;
      if (!updatedInvoiceId) return;
      state.lastStreamEventAt = nowIso();
      renderDiagnostics();
      if (!state.invoiceId || state.invoiceId === updatedInvoiceId) {
        void loadInvoice(updatedInvoiceId, { silent: true });
      }
    } catch (_error) {
      // no-op
    }
  };

  state.sse.addEventListener("snapshot", refreshFromStream);
  state.sse.addEventListener("invoice.updated", refreshFromStream);
  state.sse.addEventListener("status_changed", refreshFromStream);
  state.sse.addEventListener("heartbeat", () => {
    setNetworkStatus("リアルタイム接続中");
    setSseStatus("open", "heartbeat");
    state.lastStreamEventAt = nowIso();
    renderDiagnostics();
  });
  state.sse.addEventListener("error", () => {
    setNetworkStatus("再接続中（自動更新中）");
    setSseStatus("reconnecting", "自動再接続待ち");
    startFallbackPollingIfNeeded();
    scheduleSseReconnect();
  });
}

function formatRole(role) {
  if (role === "admin") return "管理者";
  if (role === "manager") return "マネージャー";
  return "スタッフ";
}

function canShowTab(tabName) {
  if (["reviews", "refunds", "settlement"].includes(tabName)) return isAdminRole(state.role);
  if (tabName === "settings" && state.role && !isAdminRole(state.role)) return false;
  return true;
}

function setActiveTab(tabName) {
  const requested = String(tabName || "billing");
  const nextTab = canShowTab(requested) ? requested : "billing";
  state.activeTab = nextTab;
  document.body.dataset.activeTerminalTab = nextTab;
  for (const button of el.tabButtons) {
    const isActive = button.dataset.tabTarget === nextTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  }
  for (const panel of el.tabPanels) {
    panel.hidden = panel.dataset.tabPanel !== nextTab;
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

function applyAdminVisibility() {
  const visible = isAdminRole(state.role);
  for (const section of el.adminSections) {
    section.classList.toggle("hidden", !visible);
    section.setAttribute("aria-hidden", visible ? "false" : "true");
  }
  for (const button of el.tabButtons) {
    const isAdminTab = button.dataset.adminTab === "true";
    const isSettingsTab = button.dataset.settingsTab === "true";
    const showSettings = !state.role || isAdminRole(state.role);
    button.classList.toggle("hidden", (isAdminTab && !visible) || (isSettingsTab && !showSettings));
  }
  setActiveTab(canShowTab(state.activeTab) ? state.activeTab : "billing");
}

function setReviewListState(kind, message) {
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
    OTHER: "確認が必要な支払い",
  };
  return map[code] || code || "-";
}

function renderReviewSummary(rows) {
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
  if (el.topbarOpenReviewCount) el.topbarOpenReviewCount.textContent = `${counts.open + counts.in_progress}件`;
  if (el.tabBadgeReviews) {
    const activeCount = counts.open + counts.in_progress;
    el.tabBadgeReviews.textContent = String(activeCount);
    el.tabBadgeReviews.classList.toggle("hidden", activeCount === 0);
  }
  if (el.tabBadgeRefunds) {
    el.tabBadgeRefunds.textContent = String(refundCandidateCount);
    el.tabBadgeRefunds.classList.toggle("hidden", refundCandidateCount === 0);
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
  state.refundWorkflowStatus = "draft";
  el.refundReviewCaseId.value = review.id || "";
  hintParts.push(`レビューID ${shortId(review.id, 10, 5)}`);

  if (suggestion.suggestedRefundAmount != null) {
    el.refundAmount.value = String(suggestion.suggestedRefundAmount);
    hintParts.push(`返金候補 ${formatJpyc(suggestion.suggestedRefundAmount)}`);
  } else {
    el.refundAmount.value = "";
    hintParts.push("返金候補額なし");
  }

  const chainCandidate = String(
    review?.chain_id ||
      events.find((event) => event?.chain_id)?.chain_id ||
      ""
  ).trim();
  if (chainCandidate) {
    if (Object.prototype.hasOwnProperty.call(REFUND_CHAIN_LABELS, chainCandidate)) {
      el.refundChainId.value = chainCandidate;
      hintParts.push(`チェーン ${REFUND_CHAIN_LABELS[chainCandidate]}`);
    } else {
      el.refundChainId.value = "";
      hintParts.push(`対応外チェーン ${chainCandidate}`);
    }
  } else {
    el.refundChainId.value = "";
    hintParts.push("チェーンを選択してください");
  }

  const fromAddressCandidate = events
    .map((event) => event?.from_address)
    .find((value) => isLikelyEvmAddress(value));
  if (fromAddressCandidate) {
    el.refundAddress.value = fromAddressCandidate;
    hintParts.push("返金先に支払い元アドレスを反映");
  } else {
    el.refundAddress.value = "";
    hintParts.push("返金先は手入力");
  }

  el.refundDraftHint.textContent =
    hintParts.length > 0
      ? `返金フォーム下書き: ${hintParts.join(" / ")}`
      : "返金フォームの下書き候補はありません。必要な項目を手入力してください。";
  if (el.refundSourceInvoice) el.refundSourceInvoice.textContent = review.invoice_no || review.invoice_id || shortId(review.id, 10, 5) || "未選択";
  if (el.refundSourceAmounts) {
    el.refundSourceAmounts.textContent = `請求 ${formatJpy(review.amount_jpy)} / 受取 ${formatJpyc(review.paid_amount_jpyc)}`;
  }
  if (el.refundSourceEligible) {
    el.refundSourceEligible.textContent = suggestion.suggestedRefundAmount != null ? formatJpyc(suggestion.suggestedRefundAmount) : "-";
  }
  if (el.refundSummaryReason) el.refundSummaryReason.textContent = reviewReasonLabel(review.reason_type);
  updateRefundSummary();
  updateRefundStepState();
  if (el.refundCaseListState) {
    el.refundCaseListState.className = "refund-case-card is-active";
    el.refundCaseListState.dataset.refundStatus = "approval";
    el.refundCaseListState.innerHTML = "";
    const pill = document.createElement("span");
    pill.className = "status-pill s-yellow";
    pill.textContent = "返金候補";
    const invoice = document.createElement("strong");
    invoice.className = "mono";
    invoice.textContent = review.invoice_no || review.invoice_id || shortId(review.id, 10, 5) || "-";
    const amount = document.createElement("span");
    amount.textContent = suggestion.suggestedRefundAmount != null ? formatJpyc(suggestion.suggestedRefundAmount) : "-";
    const reason = document.createElement("small");
    reason.textContent = reviewReasonLabel(review.reason_type);
    el.refundCaseListState.append(pill, invoice, amount, reason);
  }
}

function renderReviewDetail(detail = null) {
  state.selectedReviewDetail = detail;
  const review = detail?.review || null;
  const events = Array.isArray(detail?.events) ? detail.events : [];

  if (!review) {
    state.refundWorkflowStatus = "draft";
    el.reviewDetailBadge.textContent = "未選択";
    if (el.reviewDetailReasonText) el.reviewDetailReasonText.textContent = "-";
    if (el.reviewDetailExpectedAmount) el.reviewDetailExpectedAmount.textContent = "-";
    if (el.reviewDetailPaidAmount) el.reviewDetailPaidAmount.textContent = "-";
    if (el.reviewDetailDeltaAmount) el.reviewDetailDeltaAmount.textContent = "-";
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
    el.refundDraftHint.textContent =
      "レビューを選択すると、返金候補額・支払い元アドレス・チェーンIDを返金フォームへ下書きします。";
    if (el.refundSourceInvoice) el.refundSourceInvoice.textContent = "未選択";
    if (el.refundSourceAmounts) el.refundSourceAmounts.textContent = "確認待ちから返金候補を選択してください。";
    if (el.refundSourceEligible) el.refundSourceEligible.textContent = "-";
    if (el.refundSummaryAmount) el.refundSummaryAmount.textContent = "-";
    if (el.refundSummaryAddress) el.refundSummaryAddress.textContent = "未入力";
    if (el.refundSummaryReason) el.refundSummaryReason.textContent = "レビュー選択待ち";
    if (el.refundCaseListState) {
      el.refundCaseListState.className = "empty-state";
      delete el.refundCaseListState.dataset.refundStatus;
      el.refundCaseListState.textContent = "確認待ちページで返金候補を選ぶと、この一覧とフォームに反映されます。";
    }
    if (el.goRefundFromReviewBtn) el.goRefundFromReviewBtn.disabled = true;
    return;
  }

  const suggestion = computeReviewSuggestion(review);
  const relatedInvoices = Array.isArray(detail?.related_invoices) ? detail.related_invoices : [];
  const priority = reviewPriorityMeta(review);
  const ageMinutes = reviewAgeMinutes(review);
  const nextStatusLabel = reviewStatusLabel(suggestion.suggestedNextStatus || review.status);
  el.reviewDetailBadge.textContent = `${reviewStatusLabel(review.status)} / ${priority.label}`;
  if (el.reviewDetailReasonText) el.reviewDetailReasonText.textContent = reviewReasonLabel(review.reason_type);
  if (el.reviewDetailExpectedAmount) el.reviewDetailExpectedAmount.textContent = formatJpy(review.amount_jpy);
  if (el.reviewDetailPaidAmount) el.reviewDetailPaidAmount.textContent = formatJpyc(review.paid_amount_jpyc);
  if (el.reviewDetailDeltaAmount) {
    const expected = Number(review.amount_jpy);
    const paid = Number(review.paid_amount_jpyc);
    const delta = Number.isFinite(expected) && Number.isFinite(paid) ? paid - expected : null;
    el.reviewDetailDeltaAmount.textContent = delta == null ? "-" : formatJpyc(delta);
    el.reviewDetailDeltaAmount.classList.toggle("danger-text", delta != null && delta < 0);
    el.reviewDetailDeltaAmount.classList.toggle("success-text", delta != null && delta === 0);
    el.reviewDetailDeltaAmount.classList.toggle("warning-text", delta != null && delta > 0);
  }
  el.reviewDetailSummary.textContent =
    `${reviewReasonLabel(review.reason_type)} / ${formatJpy(review.amount_jpy)} / 請求状態 ${reviewStatusLabel(review.invoice_status || review.status)} / 経過 ${ageMinutes}分`;
  el.reviewDetailId.textContent = review.id || "-";
  el.reviewDetailInvoice.textContent = review.invoice_no || review.invoice_id || "-";
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

  applyRefundDraftFromReview(review, suggestion, events);
  el.reviewNextStatus.value = suggestion.suggestedNextStatus || review.status;
  if (el.goRefundFromReviewBtn) el.goRefundFromReviewBtn.disabled = false;
}

function highlightSelectedReviewRow() {
  const cards = Array.from(el.reviewCardList?.querySelectorAll("[data-review-id]") || []);
  for (const card of cards) {
    const isSelected = card.dataset.reviewId === state.selectedReviewId;
    card.classList.toggle("is-selected", isSelected);
    card.setAttribute("aria-selected", isSelected ? "true" : "false");
  }
}

async function selectReview(reviewId) {
  const nextId = String(reviewId || "").trim();
  if (!nextId || !isAdminRole(state.role)) return;
  state.selectedReviewId = nextId;
  highlightSelectedReviewRow();
  el.reviewIdInput.value = nextId;
  try {
    const data = await requestJson(`/api/v1/reviews/${encodeURIComponent(nextId)}`);
    renderReviewDetail(data);
  } catch (error) {
    renderReviewDetail(null);
    showToast(String(error.message || error), true);
  }
}

function createReviewCard(row) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "review-case-card";
  button.dataset.reviewId = row.id;
  button.setAttribute("aria-selected", "false");

  const priority = reviewPriorityMeta(row);
  const expected = Number(row.amount_jpy);
  const paid = Number(row.paid_amount_jpyc);
  const delta = Number.isFinite(expected) && Number.isFinite(paid) ? paid - expected : null;
  const age = reviewAgeMinutes(row);
  const statusClass = priority.className || "s-yellow";
  const deltaClass = delta == null ? "" : delta < 0 ? "danger-text" : delta > 0 ? "warning-text" : "success-text";

  const createdAt = row.created_at
    ? new Date(row.created_at).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "-";

  button.innerHTML = `
    <span class="review-priority-rail" aria-hidden="true"></span>
    <span class="review-card-topline">
      <span class="status-pill ${statusClass}">${priority.label}</span>
      <strong class="mono">${escapeHtml(row.invoice_no || row.invoice_id || row.id || "-")}</strong>
      <span>${escapeHtml(reviewReasonLabel(row.reason_type))}</span>
      <span class="review-age">${Number.isFinite(age) ? `${age}分前` : "-"}</span>
    </span>
    <span class="review-card-amounts">
      <span><small>請求額</small><strong>${escapeHtml(formatJpy(row.amount_jpy))}</strong></span>
      <span><small>受取額</small><strong>${escapeHtml(formatJpyc(row.paid_amount_jpyc))}</strong></span>
      <span><small>差額</small><strong class="${deltaClass}">${delta == null ? "-" : escapeHtml(formatJpyc(delta))}</strong></span>
    </span>
    <span class="review-card-meta">
      <time class="mono">${escapeHtml(createdAt)}</time>
      <span>詳細を確認 ›</span>
    </span>
  `;

  const activate = () => {
    document.querySelector(".review-workbench")?.classList.add("has-detail-open");
    void selectReview(row.id);
  };
  button.addEventListener("click", activate);
  return button;
}

async function handleLogin() {
  const terminalCode = String(el.terminalCode.value || "").trim();
  const staffPin = String(el.staffPin.value || "").trim();
  const staffPinConfirm = String(el.staffPinConfirm.value || "").trim();
  const staffName = String(el.staffNameInput?.value || "").trim();
  if (!terminalCode || !staffPin) {
    showToast("端末コードとスタッフPINを入力してください", true);
    return;
  }
  if (staffPinConfirm && staffPin !== staffPinConfirm) {
    showToast("PIN（確認）が一致しません", true);
    return;
  }

  el.loginBtn.disabled = true;
  try {
    const data = await requestJson("/api/v1/terminal-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalCode, staffPin, ...(staffName ? { staffName } : {}) }),
    });
    state.token = data.token;
    state.terminalId = data.terminalId;
    state.storeId = data.storeId;
    state.sessionId = data.sessionId;
    state.role = String(data.role || "staff");
    state.storeName = String(data.store_name || data.storeName || "JPYC Store");
    state.staffName = String(data.staff_name || data.staffName || staffName || "スタッフ");
    state.diagnosticsEnabled = data.diagnostic_mode_enabled === true;
    state.supportedWallets = Array.isArray(data.supported_wallets) ? data.supported_wallets : [];
    state.paymentChains = Array.isArray(data.payment_chains) ? data.payment_chains : [];
    state.selectedPaymentChainId = "";
    state.fixedQrUrl = typeof data.fixed_qr_url === "string" ? data.fixed_qr_url : "";
    state.fixedQrToken = typeof data.public_entry_token === "string" ? data.public_entry_token : "";

    setLoggedInUi(true);
    el.sessionText.textContent = state.sessionId;
    if (el.topbarStoreText) el.topbarStoreText.textContent = state.storeName;
    if (el.topbarTerminalNameText) el.topbarTerminalNameText.textContent = state.terminalId || terminalCode;
    if (el.topbarBusinessDateText) el.topbarBusinessDateText.textContent = new Date().toISOString().slice(0, 10);
    renderTopbarRole();
    renderSettingsSessionSummary();
    el.sessionExpiryText.textContent = `${data.session_ttl_sec} 秒`;
    setNetworkStatus("認証済み");
    renderCustomerFacingQr();
    applyAdminVisibility();
    setActiveTab("billing");
    renderDiagnostics();
    renderOperatorGuide();
    renderPaymentChains();
    if (data.current_invoice?.invoice_id) {
      await loadInvoice(data.current_invoice.invoice_id, { silent: true });
    } else {
      clearInvoiceView();
    }
    if (isAdminRole(state.role)) {
      await loadOpsSnapshot();
      startOpsAutoRefresh();
      void loadReviews();
    } else {
      await loadOpsWarnings();
      if (el.topbarOpenReviewCount) el.topbarOpenReviewCount.textContent = "管理者のみ";
      setReviewListState("empty", "管理者権限でログインすると確認待ち一覧を表示できます。");
    }
    void refreshTerminalDiagnostics();
    showToast("ログインしました");
  } catch (error) {
    showToast(String(error.message || error), true);
  } finally {
    el.loginBtn.disabled = false;
  }
}

window.handleLogin = handleLogin;

async function handleCreateInvoice() {
  if (!state.token) {
    showToast("先にログインしてください", true);
    return;
  }
  if (state.invoiceId && ACTIVE_INVOICE_STATUSES.has(state.invoiceStatus)) {
    showToast("現在の会計が残っています。再発行またはQR停止後に新規会計を開始してください。", true);
    return;
  }
  const amount = Number(el.amountInput.value);
  if (!Number.isInteger(amount) || amount <= 0) {
    el.amountInputError.textContent = "金額は1円以上の整数で入力してください。";
    if (el.paymentChainHint) el.paymentChainHint.textContent = "";
    return;
  }
  const chain = selectedPaymentChain();
  if (!chain?.chain_id) {
    el.amountInputError.textContent = "";
    if (el.paymentChainHint) el.paymentChainHint.textContent = "チェーン選択から支払いチェーンを選択してください";
    return;
  }
  if (chain.issue_available === false || chain.status === "unavailable") {
    el.amountInputError.textContent = "";
    if (el.paymentChainHint) el.paymentChainHint.textContent = chain.unavailable_reason || "このチェーンでは現在請求を作成できません。";
    return;
  }
  el.amountInputError.textContent = "";
  if (el.paymentChainHint) el.paymentChainHint.textContent = "";
  el.createInvoiceBtn.disabled = true;
  el.createInvoiceBtn.classList.add("loading");
  try {
    const data = await requestJson("/api/v1/invoices", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("invoice"),
      },
      body: JSON.stringify({ amount_jpy: amount, payment_chain_id: String(chain.chain_id) }),
    });
    showToast(`${chain.short_name || chain.network || "選択チェーン"}で請求を作成しました`);
    await loadInvoice(data.invoice_id);
  } catch (error) {
    if (error?.payload?.error?.code === "TERMINAL_ACTIVE_INVOICE_EXISTS") {
      const activeInvoice = error.payload?.error?.details?.active_invoice;
      if (activeInvoice?.invoice_id) {
        try {
          await loadInvoice(activeInvoice.invoice_id, { silent: true });
        } catch (_innerError) {
          // no-op
        }
      }
      showToast("現在の会計が残っています。再発行またはQR停止後に新規会計を開始してください。", true);
    } else {
      showToast(String(error.message || error), true);
    }
  } finally {
    el.createInvoiceBtn.classList.remove("loading");
    el.createInvoiceBtn.disabled = false;
  }
}

async function postInvoiceAction(actionPath, actionLabel) {
  if (!state.invoiceId) {
    showToast("対象の請求がありません", true);
    return;
  }
  try {
    await requestJson(`/api/v1/invoices/${encodeURIComponent(state.invoiceId)}/${actionPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey(`invoice-${actionPath}`),
      },
      body: "{}",
    });
    showToast(actionLabel);
    if (["cancel", "expire"].includes(actionPath)) {
      await loadInvoice(state.invoiceId, { silent: true });
      if (isAdminRole(state.role)) {
        void loadOpsSnapshot();
      } else {
        void loadOpsWarnings();
      }
      return;
    }
    await loadInvoice(state.invoiceId, { silent: true });
  } catch (error) {
    showToast(String(error.message || error), true);
  }
}

async function handleReissueInvoice() {
  if (!state.invoiceId) {
    showToast("再発行対象の請求がありません", true);
    return;
  }
  el.reissueInvoiceBtn.disabled = true;
  closeSse("再発行中");
  stopFallbackPolling();
  try {
    const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(state.invoiceId)}/reissue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("invoice-reissue"),
      },
      body: "{}",
    });
    showToast("QRを再発行しました");
    await loadInvoice(data.invoice_id, { silent: true });
  } catch (error) {
    showToast(String(error.message || error), true);
  } finally {
    el.reissueInvoiceBtn.disabled = false;
  }
}

async function handlePresentTap() {
  if (!state.invoiceId) {
    showToast("tap 提示対象の請求がありません", true);
    return;
  }
  el.presentTapBtn.disabled = true;
  try {
    const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(state.invoiceId)}/provider-sessions:present`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("provider-present"),
      },
      body: "{}",
    });
    if (data.duplicate) {
      showToast("すでにタッチ決済を提示中です");
    } else {
      showToast("タッチ決済を提示しました");
    }
    await loadInvoice(data.invoice_id || state.invoiceId, { silent: true });
  } catch (error) {
    showToast(String(error.message || error), true);
  } finally {
    if (state.currentInvoice) {
      renderProviderControls(state.currentInvoice);
    } else {
      el.presentTapBtn.disabled = false;
    }
  }
}

async function handleResumeQr() {
  if (!state.invoiceId) {
    showToast("QRへ戻す対象の請求がありません", true);
    return;
  }
  if (el.resumeQrBtn) el.resumeQrBtn.disabled = true;
  try {
    const data = await requestJson(`/api/v1/invoices/${encodeURIComponent(state.invoiceId)}/provider-sessions:cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("provider-cancel"),
      },
      body: "{}",
    });
    showToast("QR案内へ戻しました");
    await loadInvoice(data.invoice_id || state.invoiceId, { silent: true });
  } catch (error) {
    showToast(String(error.message || error), true);
  } finally {
    if (state.currentInvoice) {
      renderProviderControls(state.currentInvoice);
    } else {
      if (el.resumeQrBtn) el.resumeQrBtn.disabled = false;
    }
  }
}

async function loadReviews() {
  if (!isAdminRole(state.role)) return;
  setReviewListState("loading", "確認待ち支払いを読み込み中です...");
  if (el.reviewCardList) el.reviewCardList.innerHTML = "";

  const status = String(el.reviewStatusFilter.value || "");
  const query = status ? `?status=${encodeURIComponent(status)}` : "";

  try {
    const data = await requestJson(`/api/v1/reviews${query}`);
    const rows = Array.isArray(data.reviews) ? [...data.reviews].sort(compareReviewsByPriority) : [];
    state.reviewRows = rows;
    renderReviewSummary(rows);
    setLastUpdated(el.reviewsLastUpdatedText);
    if (rows.length === 0) {
      state.selectedReviewId = "";
      renderReviewDetail(null);
      setReviewListState("empty", "確認待ちの支払いはありません。");
      return;
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
      if (el.reviewCardList) el.reviewCardList.appendChild(createReviewCard(row));
    }
    const nextSelection = rows.some((row) => row.id === state.selectedReviewId) ? state.selectedReviewId : rows[0]?.id;
    if (nextSelection) {
      await selectReview(nextSelection);
    }
    highlightSelectedReviewRow();
  } catch (error) {
    state.selectedReviewId = "";
    renderReviewDetail(null);
    renderReviewSummary([]);
    setLastUpdated(el.reviewsLastUpdatedText);
    setReviewListState("error", "読み込みに失敗しました。もう一度お試しください。");
    showToast(String(error.message || error), true);
  }
}

async function handleUpdateReview() {
  const reviewId = String(el.reviewIdInput.value || "").trim();
  if (!reviewId) {
    showToast("レビューIDを入力してください", true);
    return;
  }
  try {
    await requestJson(`/api/v1/reviews/${encodeURIComponent(reviewId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("review-update"),
      },
      body: JSON.stringify({
        status: el.reviewNextStatus.value,
        resolution_note: String(el.reviewNote.value || "").trim() || null,
      }),
    });
    showToast("レビューを更新しました");
    await loadReviews();
    await loadOpsSnapshot();
  } catch (error) {
    showToast(String(error.message || error), true);
  }
}

function isHexTxHash(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

async function handleRequestRefund() {
  const reviewCaseId = String(el.refundReviewCaseId.value || "").trim();
  const refundAmount = Number(el.refundAmount.value);
  const refundToAddress = String(el.refundAddress.value || "").trim();
  const refundChainId = String(el.refundChainId.value || "").trim();
  const evidenceNotePath = String(el.refundEvidenceNotePathInput?.value || "").trim();
  const customerNote = String(el.refundCustomerNoteInput?.value || "").trim();
  if (!reviewCaseId || !Number.isFinite(refundAmount) || refundAmount <= 0 || !refundToAddress || !refundChainId) {
    showToast("返金申請の入力項目を確認してください", true);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(REFUND_CHAIN_LABELS, refundChainId)) {
    showToast("返金チェーンは Polygon または Avalanche を選択してください", true);
    return;
  }
  if (!isLikelyEvmAddress(refundToAddress)) {
    showToast("返金先アドレスの形式を確認してください", true);
    return;
  }
  try {
    const data = await requestJson("/api/v1/refunds", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("refund-request"),
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
    el.refundIdInput.value = data.refund_request_id || "";
    state.refundWorkflowStatus = "requested";
    updateRefundStepState("承認待ち");
    showToast("返金申請を作成しました");
  } catch (error) {
    showToast(String(error.message || error), true);
  }
}

async function handleApproveRefund() {
  const refundId = String(el.refundIdInput.value || "").trim();
  if (!refundId) {
    showToast("返金IDを入力してください", true);
    return;
  }
  try {
    await requestJson(`/api/v1/refunds/${encodeURIComponent(refundId)}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("refund-approve"),
      },
      body: "{}",
    });
    state.refundWorkflowStatus = "approved";
    updateRefundStepState("外部実行待ち");
    showToast("返金申請を承認しました");
  } catch (error) {
    showToast(String(error.message || error), true);
  }
}

async function handleExecuteRefund() {
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
    showToast("返金に使った店舗ウォレットの形式を確認してください", true);
    return;
  }
  if (!state.pendingRefundExecute) {
    state.pendingRefundExecute = true;
    const shortTx = shortId(txHash);
    showToast(`返金記録を保存するには${Math.ceil(REFUND_EXECUTE_CONFIRM_MS / 1000)}秒以内にもう一度押してください`, true);
    startConfirmationCountdown({
      hintEl: el.executeRefundHint,
      timeoutMs: REFUND_EXECUTE_CONFIRM_MS,
      countdownTimerName: "pendingRefundExecuteCountdownTimer",
      timeoutTimerName: "pendingRefundExecuteTimer",
      messageForSeconds: (remainingSec) =>
        `外部ウォレットで返金を実行済みであることを確認してください。返金記録 ${shortTx} を保存するには、あと${remainingSec}秒以内に同じボタンをもう一度押してください。`,
      onExpire: () => {
        state.pendingRefundExecute = false;
        el.executeRefundHint.classList.remove("hidden");
        el.executeRefundHint.textContent = "返金記録保存の確認は時間切れです。必要ならもう一度押してください。";
      },
    });
    return;
  }
  state.pendingRefundExecute = false;
  clearCountdownTimer("pendingRefundExecuteCountdownTimer");
  clearTimeoutTimer("pendingRefundExecuteTimer");
  try {
    const data = await requestJson(`/api/v1/refunds/${encodeURIComponent(refundId)}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("refund-execute"),
      },
      body: JSON.stringify({
        executor_type: "manual",
        refund_tx_hash: txHash,
        executed_wallet: executedWallet || null,
        evidence_note_path: evidenceNotePath || null,
        customer_note: customerNote || null,
      }),
    });
    el.executeRefundHint.classList.remove("hidden");
    if (data.status === "recorded") {
      el.executeRefundHint.textContent = "返金記録を保存しました。検証待ちです。";
      state.refundWorkflowStatus = "recorded";
      updateRefundStepState("検証待ち");
    } else {
      state.refundWorkflowStatus = String(data.status || "").includes("succeeded") ? "verified" : "recorded";
      el.executeRefundHint.textContent = `返金状態: ${data.status}`;
      updateRefundStepState(String(data.status || "証跡入力"));
    }
    showToast("返金記録を保存しました");
  } catch (error) {
    el.executeRefundHint.classList.remove("hidden");
    el.executeRefundHint.textContent = String(error.message || error);
    showToast(String(error.message || error), true);
  }
}

async function handleVerifyRefund() {
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

  try {
    const data = await requestJson(`/api/v1/refunds/${encodeURIComponent(refundId)}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("refund-verify"),
      },
      body: JSON.stringify(payload),
    });
    el.executeRefundHint.classList.remove("hidden");
    el.executeRefundHint.textContent =
      data.status === "succeeded" ? "返金のオンチェーン検証が完了しました。" : `返金状態: ${data.status}`;
    state.refundWorkflowStatus = data.status === "succeeded" ? "verified" : "recorded";
    updateRefundStepState(data.status === "succeeded" ? "検証済み" : String(data.status || "証跡入力"));
    showToast("返金txの検証が完了しました");
  } catch (error) {
    el.executeRefundHint.classList.remove("hidden");
    el.executeRefundHint.textContent = String(error.message || error);
    showToast(String(error.message || error), true);
  }
}

async function handleCloseSettlement() {
  const businessDate = String(el.businessDateInput.value || "").trim();
  if (!isValidIsoDate(businessDate)) {
    showToast("対象営業日は YYYY-MM-DD 形式で入力してください", true);
    return;
  }
  if (state.pendingSettlementClose !== businessDate) {
    state.pendingSettlementClose = businessDate;
    const openReviews = el.opsOpenReviewCount?.textContent || "-";
    const refundCandidates = el.opsRefundCandidateCount?.textContent || "-";
    if (el.settlementConfirmPanel) el.settlementConfirmPanel.classList.remove("hidden");
    showToast(`日次締めは${Math.ceil(SETTLEMENT_CLOSE_CONFIRM_MS / 1000)}秒以内にもう一度押すと実行します`, true);
    startConfirmationCountdown({
      hintEl: el.closeSettlementHint,
      timeoutMs: SETTLEMENT_CLOSE_CONFIRM_MS,
      countdownTimerName: "pendingSettlementCloseCountdownTimer",
      timeoutTimerName: "pendingSettlementCloseTimer",
      messageForSeconds: (remainingSec) =>
        `${businessDate} の日次締めを確認中です。未解決レビュー ${openReviews}、返金候補 ${refundCandidates}、操作履歴を確認し、あと${remainingSec}秒以内に同じボタンをもう一度押すと実行します。`,
      onExpire: () => {
        if (state.pendingSettlementClose === businessDate) state.pendingSettlementClose = "";
        if (el.settlementConfirmPanel) el.settlementConfirmPanel.classList.add("hidden");
        el.closeSettlementHint.classList.remove("hidden");
        el.closeSettlementHint.textContent = "日次締め確認は時間切れです。必要ならもう一度押してください。";
      },
    });
    return;
  }
  state.pendingSettlementClose = "";
  clearCountdownTimer("pendingSettlementCloseCountdownTimer");
  clearTimeoutTimer("pendingSettlementCloseTimer");
  if (el.settlementConfirmPanel) el.settlementConfirmPanel.classList.add("hidden");
  try {
    const data = await requestJson("/api/v1/settlements/daily:close", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("settlement-close"),
      },
      body: JSON.stringify({ business_date: businessDate }),
    });
    el.closeSettlementHint.classList.remove("hidden");
    if (data.warning === "UNRESOLVED_REVIEWS") {
      const ids = Array.isArray(data.review_invoice_ids) ? data.review_invoice_ids.join(", ") : "";
      el.closeSettlementHint.textContent = `未解決レビュー ${data.review_count} 件（${ids}）`;
    } else {
      el.closeSettlementHint.textContent = "日次締めを完了しました。";
    }
    await loadOpsSnapshot();
    showToast("日次締めを実行しました");
  } catch (error) {
    el.closeSettlementHint.classList.remove("hidden");
    el.closeSettlementHint.textContent = String(error.message || error);
    showToast(String(error.message || error), true);
  }
}

function downloadTextFile(body, headers, fallbackFileName) {
  const nameHint = headers.get("content-disposition");
  const fileNameMatch = nameHint ? nameHint.match(/filename=\"?([^\";]+)\"?/) : null;
  const fileName = fileNameMatch?.[1] || fallbackFileName;
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function updateBusinessDateHeader() {
  if (!el.businessDateHeaderText) return;
  const businessDate = String(el.businessDateInput?.value || "").trim();
  if (!isValidIsoDate(businessDate)) {
    el.businessDateHeaderText.textContent = "--/--/--";
    return;
  }
  const [, month, day] = businessDate.split("-");
  el.businessDateHeaderText.textContent = `${month}/${day}`;
}

async function handleExportDailyCsv() {
  const businessDate = String(el.businessDateInput.value || "").trim();
  if (!isValidIsoDate(businessDate)) {
    showToast("対象日は YYYY-MM-DD 形式で入力してください", true);
    return;
  }
  try {
    const { body, headers } = await requestText(
      `/api/v1/settlements/daily:export?business_date=${encodeURIComponent(businessDate)}&format=csv`
    );
    downloadTextFile(body, headers, `settlement-${businessDate}.csv`);
    showToast(`${businessDate} の日次CSVを出力しました`);
  } catch (error) {
    showToast(String(error.message || error), true);
  }
}

async function handleExportAuditLogCsv() {
  try {
    const { body, headers } = await requestText("/api/v1/audit-logs/export?format=csv&limit=1000");
    downloadTextFile(body, headers, `audit-${nowIsoDate()}.csv`);
    showToast("操作履歴CSVを出力しました");
  } catch (error) {
    showToast(String(error.message || error), true);
  }
}

async function handleExportMonthlyCsv() {
  const yearMonth = String(el.businessMonthInput.value || "").trim();
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    showToast("対象月は YYYY-MM 形式で入力してください", true);
    return;
  }
  try {
    const { body, headers } = await requestText(
      `/api/v1/settlements/monthly:export?year_month=${encodeURIComponent(yearMonth)}&format=csv`
    );
    downloadTextFile(body, headers, `settlement-monthly-${yearMonth}.csv`);
    showToast(`${yearMonth} の月次CSVを出力しました`);
  } catch (error) {
    showToast(String(error.message || error), true);
  }
}

async function loadOpsWarnings() {
  try {
    const monitor = await requestJson("/api/v1/chain-monitor/status");
    const warnings = buildMonitorWarnings(monitor);
    renderOpsWarningsList(warnings);
    return warnings;
  } catch (_error) {
    const warnings = ["監視状態を取得できませんでした"];
    renderOpsWarningsList(warnings);
    return warnings;
  }
}

async function handleShowOpsWarnings() {
  if (!toggleSettingsAdminResult("warnings")) return;
  openSettingsAdminResult(
    "運用警告",
    "通信監視・状態更新・受取アドレス残数など、店舗運用に影響する警告を確認します。"
  );
  appendAdminResultText("最新の警告を取得しています...");
  const warnings = await loadOpsWarnings();
  el.settingsAdminResultBody.innerHTML = "";
  if (!warnings.length) {
    appendAdminResultText("重大な警告はありません。", "ok");
  } else {
    warnings.forEach((warning) => appendAdminResultText(warning, "warning"));
  }
  el.opsWarnings?.closest(".settings-warnings-row")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function handleOpenAuditLogs() {
  if (!toggleSettingsAdminResult("audit")) return;
  openSettingsAdminResult(
    "監査ログ",
    "ログイン、請求、返金証跡、締め、設定変更などの操作履歴を最新順で表示します。"
  );
  appendAdminResultText("最新の監査ログを取得しています...");
  try {
    const data = await requestJson("/api/v1/audit-logs?limit=8");
    const rows = Array.isArray(data?.audit_logs) ? data.audit_logs : [];
    el.settingsAdminResultBody.innerHTML = "";
    if (rows.length === 0) {
      appendAdminResultText("表示できる監査ログはありません。");
      return;
    }
    for (const row of rows) {
      appendAdminResultRow(
        `${formatDateTime(row.created_at)} / ${row.action || "-"}`,
        `${row.target_type || "-"} ${row.target_id || ""}`.trim()
      );
    }
  } catch (error) {
    el.settingsAdminResultBody.innerHTML = "";
    appendAdminResultText(`監査ログを取得できませんでした: ${error.message || error}`, "danger");
  }
}

async function refreshTerminalDiagnostics({ showUpdatedToast = false } = {}) {
  if (!el.terminalDiagnosticsPanel || !el.terminalDiagnosticsBody) return;
  el.terminalDiagnosticsPanel.classList.remove("hidden");
  el.terminalDiagnosticsBody.innerHTML = "";
  appendTerminalDiagnosticsRow("診断状態", "端末状態を確認しています...");
  let warnings = [];
  try {
    warnings = await loadOpsWarnings();
  } catch (_error) {
    warnings = ["運用警告を取得できませんでした"];
  }
  el.terminalDiagnosticsBody.innerHTML = "";
  appendTerminalDiagnosticsRow("ログイン状態", state.token ? `ログイン中（${state.role || "-"}）` : "未ログイン", state.token ? "ok" : "warning");
  appendTerminalDiagnosticsRow("接続状態", el.networkText?.textContent || "-", state.token ? "ok" : "");
  appendTerminalDiagnosticsRow("リアルタイム更新", `${state.sseStatus || "-"} / ${state.fallbackPollingStatus || "-"}`);
  appendTerminalDiagnosticsRow("現在の請求", state.invoiceId || "未作成");
  appendTerminalDiagnosticsRow("最終請求更新", formatDateTime(state.lastInvoiceRefreshAt));
  appendTerminalDiagnosticsRow("運用警告", warnings.length ? `${warnings.length}件` : "0件", warnings.length ? "warning" : "ok");
  if (showUpdatedToast) showToast("端末診断を更新しました");
}

function saveTerminalSettings() {
  writeTerminalSettings(
    {
      volume: Number(el.volumeInput.value || 0.8),
      brightness: Number(el.brightnessInput?.value || 0.7),
      display_font_size: document.body.dataset.terminalFontSize || "standard",
      auto_reset_sec: Number(el.autoResetSecInput.value || 120),
    },
    { showSavedToast: true }
  );
  updateSettingsSaveState();
}

function loadTerminalSettings() {
  const settings = readTerminalSettings();
  el.volumeInput.value = String(settings.volume);
  if (el.brightnessInput) el.brightnessInput.value = String(settings.brightness);
  el.autoResetSecInput.value = String(settings.auto_reset_sec);
  syncSettingsRangeControls();
  applyDisplayFontSize(settings.display_font_size);
  renderAmountPresetButtons();
  updateSettingsSaveState();
}

function bindEvents() {
  for (const button of el.tabButtons) {
    button.addEventListener("click", () => setActiveTab(button.dataset.tabTarget));
  }
  el.loginBtn.addEventListener("click", () => void handleLogin());
  if (el.adminLoginShortcutBtn) {
    el.adminLoginShortcutBtn.addEventListener("click", () => {
      el.staffPin?.focus();
      showToast("管理者PINを入力して端末を開始してください");
    });
  }
  if (el.loginStatusDetailBtn) {
    el.loginStatusDetailBtn.addEventListener("click", () => {
      if (state.token) {
        void loadOpsWarnings();
        showToast("通信状態と運用警告を更新しました");
        return;
      }
      showToast("端末開始後に詳細な運用状態を確認できます");
    });
  }
  el.lockTerminalBtn?.addEventListener("click", handleLockTerminal);
  el.logoutTerminalBtn?.addEventListener("click", () => void handleLogoutTerminal());
  el.amountPresetList.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-preset-action]");
    if (!actionButton) return;
    const amount = actionButton.dataset.amountPreset || "";
    if (actionButton.dataset.presetAction === "use") {
      applyAmountPreset(amount);
      return;
    }
    if (actionButton.dataset.presetAction === "edit") {
      handleEditAmountPreset(amount);
      return;
    }
    if (actionButton.dataset.presetAction === "remove") {
      handleRemoveAmountPreset(amount);
    }
  });
  el.addPresetBtn.addEventListener("click", handleAddAmountPreset);
  el.resetPresetBtn.addEventListener("click", handleResetAmountPresets);
  el.presetAmountInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAddAmountPreset();
    }
  });
  el.amountInput.addEventListener("input", updateAmountPreview);
  el.createInvoiceBtn.addEventListener("click", () => void handleCreateInvoice());
  el.cancelInvoiceBtn.addEventListener("click", confirmStopQrAction);
  el.expireInvoiceBtn?.addEventListener("click", () => confirmDangerInvoiceAction("expire", "請求を期限切れに"));
  el.refreshBtn.addEventListener("click", () => {
    if (!state.invoiceId) return;
    void loadInvoice(state.invoiceId);
  });
  if (el.connectionRefreshBtn) {
    el.connectionRefreshBtn.addEventListener("click", () => {
      if (state.invoiceId) {
        void loadInvoice(state.invoiceId);
        return;
      }
      void loadOpsWarnings();
    });
  }
  el.reissueInvoiceBtn.addEventListener("click", () => void handleReissueInvoice());
  if (el.copyPaymentUrlBtn) el.copyPaymentUrlBtn.addEventListener("click", () => void copyPaymentUrl());
  el.presentTapBtn.addEventListener("click", () => void handlePresentTap());
  if (el.resumeQrBtn) el.resumeQrBtn.addEventListener("click", () => void handleResumeQr());

  el.loadReviewsBtn.addEventListener("click", () => void loadReviews());
  el.reviewStatusFilter.addEventListener("change", () => void loadReviews());
  document.querySelectorAll("[data-review-filter-value]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextValue = button.dataset.reviewFilterValue || "";
      el.reviewStatusFilter.value = nextValue;
      document.querySelectorAll("[data-review-filter-value]").forEach((node) => {
        node.classList.toggle("is-active", node === button);
      });
      void loadReviews();
    });
  });
  if (el.reviewSearchInput) {
    el.reviewSearchInput.addEventListener("input", () => {
      const query = String(el.reviewSearchInput.value || "").trim().toLowerCase();
      const cards = Array.from(el.reviewCardList?.querySelectorAll("[data-review-id]") || []);
      let visibleCount = 0;
      for (const card of cards) {
        const matches = !query || card.textContent.toLowerCase().includes(query);
        card.classList.toggle("hidden", !matches);
        if (matches) visibleCount += 1;
      }
      if (query && cards.length > 0 && visibleCount === 0) {
        setReviewListState("empty", `「${query}」に一致する確認待ちはありません。`);
      } else if (query && visibleCount > 0) {
        setReviewListState("empty", `${visibleCount} 件の確認待ちが一致しました。`);
      } else if (cards.length > 0) {
        const activeRows = state.reviewRows.filter((row) => ["open", "in_progress"].includes(String(row.status || "")));
        const topReview = activeRows[0] || null;
        setReviewListState(
          "empty",
          topReview
            ? `${state.reviewRows.length} 件のレビュー。最優先: ${reviewReasonLabel(topReview.reason_type)}（${shortId(topReview.id)}）`
            : `${state.reviewRows.length} 件のレビューがあります。`
        );
      }
    });
  }
  el.updateReviewBtn.addEventListener("click", () => void handleUpdateReview());
  if (el.reviewHoldBtn) {
    el.reviewHoldBtn.addEventListener("click", () => {
      el.reviewNextStatus.value = "open";
      void handleUpdateReview();
    });
  }
  if (el.reviewRejectBtn) {
    el.reviewRejectBtn.addEventListener("click", () => {
      el.reviewNextStatus.value = "rejected";
      void handleUpdateReview();
    });
  }
  if (el.goRefundFromReviewBtn) {
    el.goRefundFromReviewBtn.addEventListener("click", () => {
      setActiveTab("refunds");
      showToast("選択中レビューの返金候補を返金フォームに引き継ぎました");
      el.refundReviewCaseId?.focus();
    });
  }
  if (el.reviewMobileBackBtn) {
    el.reviewMobileBackBtn.addEventListener("click", () => {
      document.querySelector(".review-workbench")?.classList.remove("has-detail-open");
    });
  }

  el.requestRefundBtn.addEventListener("click", () => void handleRequestRefund());
  el.refundIdInput.addEventListener("input", () => {
    state.refundWorkflowStatus = String(el.refundIdInput.value || "").trim() ? "requested" : "draft";
    updateRefundStepState();
  });
  el.refundAmount?.addEventListener("input", () => updateRefundStepState());
  el.refundAddress?.addEventListener("input", () => updateRefundStepState());
  el.refundTxHashInput?.addEventListener("input", () => updateRefundStepState());
  el.refundEvidenceNotePathInput?.addEventListener("change", updateRefundEvidencePathHint);
  el.refreshRefundsBtn?.addEventListener("click", () => {
    void loadOpsSnapshot();
    showToast("返金候補と締め前チェックを更新しました");
  });
  document.querySelectorAll("[data-refund-filter]").forEach((button) => {
    button.addEventListener("click", () => setRefundCaseFilter(button.dataset.refundFilter));
  });
  el.approveRefundBtn.addEventListener("click", () => void handleApproveRefund());
  el.executeRefundBtn.addEventListener("click", () => void handleExecuteRefund());
  el.verifyRefundBtn.addEventListener("click", () => void handleVerifyRefund());

  el.closeSettlementBtn.addEventListener("click", () => void handleCloseSettlement());
  el.exportAuditCsvBtn.addEventListener("click", () => void handleExportDailyCsv());
  el.exportAuditLogCsvBtn?.addEventListener("click", () => void handleExportAuditLogCsv());
  el.exportMonthlyCsvBtn.addEventListener("click", () => void handleExportMonthlyCsv());
  el.saveSettingsBtn.addEventListener("click", saveTerminalSettings);
  el.showOpsWarningsBtn?.addEventListener("click", () => void handleShowOpsWarnings());
  el.openAuditLogsBtn?.addEventListener("click", () => void handleOpenAuditLogs());
  el.closeSettingsAdminResultBtn?.addEventListener("click", closeSettingsAdminResult);
  el.testNotificationSoundBtn?.addEventListener("click", () => {
    void playNotificationTestSound().catch(() => {
      showToast("通知音を再生できませんでした。端末の音量設定を確認してください");
    });
  });
  el.volumeInput.addEventListener("input", () => {
    syncSettingsRangeControls();
    updateSettingsSaveState();
  });
  el.brightnessInput?.addEventListener("input", () => {
    syncSettingsRangeControls();
    updateSettingsSaveState();
  });
  el.autoResetSecInput.addEventListener("input", updateSettingsSaveState);
  for (const button of el.fontSizeButtons) {
    button.addEventListener("click", () => {
      const nextSize = button.dataset.fontSizeOption || "standard";
      applyDisplayFontSize(nextSize);
      updateSettingsSaveState();
    });
  }
  el.refreshOpsSnapshotBtn.addEventListener("click", () => void loadOpsSnapshot());
  document.querySelectorAll("[data-tab-target-proxy]").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tabTargetProxy));
  });
  document.getElementById("refreshSettlementCheckBtn")?.addEventListener("click", () => void loadOpsSnapshot());
  el.businessDateInput.addEventListener("change", () => {
    updateBusinessDateHeader();
    if (!isAdminRole(state.role)) return;
    void loadOpsSnapshot();
  });

  window.addEventListener("beforeunload", () => {
    closeSse();
    stopFallbackPolling();
    stopOpsAutoRefresh();
  });
}

function shouldRunLocalSimulatorAutoLogin() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("simulatorAutoLogin") !== "1") return false;
  const hostname = window.location.hostname;
  const isPrivateLanHost = /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname);
  return ["localhost", "127.0.0.1"].includes(hostname) || isPrivateLanHost;
}

async function maybeRunLocalSimulatorAutoLogin() {
  if (!shouldRunLocalSimulatorAutoLogin()) return;
  if (state.token) return;
  if (localSimulatorAutoLoginStarted) return;
  localSimulatorAutoLoginStarted = true;
  window.__jpycSimulatorAutoLoginStarted = true;
  if (el.terminalCode) {
    el.terminalCode.value = "TERM-001";
  }
  if (el.staffPin) el.staffPin.value = "1234";
  if (el.staffPinConfirm) el.staffPinConfirm.value = "";
  if (el.staffNameInput) el.staffNameInput.value = "";
  await handleLogin();
}

function init() {
  if (!["localhost", "127.0.0.1", ""].includes(window.location.hostname)) {
    document.querySelectorAll(".dev-only-link").forEach((node) => node.classList.add("hidden"));
  }
  clearInvoiceView();
  setLoggedInUi(false);
  loadTerminalSettings();
  updateAmountPreview();
  bindEvents();
  void maybeRunLocalSimulatorAutoLogin();
  applyAdminVisibility();
  renderReviewSummary([]);
  setReviewListState("empty", "ログイン後に確認待ち一覧を読み込めます。");
  renderReviewDetail(null);
  el.opsSnapshotState.textContent = "ログイン後に review / settlement / monitor を集約し、優先確認項目を表示します。";
  el.opsOpenReviewCount.textContent = "-";
  el.opsDeadLetterCount.textContent = "-";
  el.opsSettlementStatus.textContent = "-";
  el.opsRecommendedAction.textContent = "-";
  el.opsPriorityReview.textContent = "-";
  el.opsRefundCandidateCount.textContent = "-";
  renderTopbarRole();
  renderSettingsSessionSummary();
  if (el.topbarOpenReviewCount) el.topbarOpenReviewCount.textContent = "-";
  setChecklist(el.opsSnapshotChecklist, ["小規模現場向けに、必要な運用項目だけをコンパクトに表示します。"]);
  el.businessDateInput.value = nowIsoDate();
  el.businessMonthInput.value = nowIsoDate().slice(0, 7);
  updateBusinessDateHeader();
  setNetworkStatus("未接続");
  updateRefundStepState();
  renderDiagnostics();
  renderOperatorGuide();
  void refreshTerminalDiagnostics();
  setActiveTab("billing");
  void maybeRunLocalSimulatorAutoLogin();
  window.setTimeout(() => void maybeRunLocalSimulatorAutoLogin(), 500);
}

try {
  init();
} catch (error) {
  console.error(error);
  void maybeRunLocalSimulatorAutoLogin();
}

window.addEventListener("load", () => {
  void maybeRunLocalSimulatorAutoLogin();
  window.setTimeout(() => void maybeRunLocalSimulatorAutoLogin(), 800);
}, { once: true });
