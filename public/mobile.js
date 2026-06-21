const query = new URLSearchParams(location.search);
const invoiceId = query.get("invoiceId");
const sig = query.get("sig");
const exp = query.get("exp");
const nonce = query.get("nonce");
const SETTINGS_KEY = "jpyc_terminal_settings";
const FONT_SIZE_OPTIONS = new Set(["small", "standard", "large"]);

function readDisplayFontSizeSetting() {
  const querySize = query.get("fontSize") || query.get("displayFontSize");
  if (FONT_SIZE_OPTIONS.has(querySize)) return querySize;
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return FONT_SIZE_OPTIONS.has(parsed?.display_font_size) ? parsed.display_font_size : "standard";
  } catch (_error) {
    return "standard";
  }
}

function applyDisplayFontSizeSetting() {
  document.body.dataset.terminalFontSize = readDisplayFontSizeSetting();
}

applyDisplayFontSizeSetting();

function receiptFontStepPx() {
  const size = readDisplayFontSizeSetting();
  if (size === "small") return -1;
  if (size === "large") return 2;
  return 0;
}

function steppedReceiptPx(baseSize) {
  return `${baseSize + receiptFontStepPx()}px`;
}

const POLICY_URLS = {
  terms: "",
  privacy: "",
  refund: "",
};

const POLICY_VERSIONS = {
  terms_version: "draft-v1",
  privacy_version: "draft-v1",
  refund_policy_version: "draft-v1",
};

const INVOICE_STATUS_ALIASES = Object.freeze({
  manual_review: "review_required",
});

const POLL_INTERVAL_MS = 5000;
const FINAL_STATUSES = new Set(["paid", "settled", "review_required", "expired", "cancelled"]);
const WAITING_STATUSES = new Set(["issued", "open", "payment_detected", "confirming"]);
const PAYMENT_INITIATION_STATUSES = new Set(["issued", "open"]);
const STAFF_STATUSES = new Set(["review_required", "expired", "cancelled"]);

const STATUS_COPY = {
  issued: { label: "支払い待ち", pill: "s-blue", title: "送金をお待ちしています" },
  open: { label: "支払い待ち", pill: "s-blue", title: "送金をお待ちしています" },
  payment_detected: { label: "確認中", pill: "s-blue", title: "支払いを確認中です。追加で送金しないでください。この画面を閉じずにお待ちください。" },
  confirming: { label: "確認中", pill: "s-blue", title: "支払いを確認中です。追加で送金しないでください。この画面を閉じずにお待ちください。" },
  paid: { label: "支払い確認済み", pill: "s-green", title: "支払いを確認しました" },
  settled: { label: "確定済み", pill: "s-green", title: "支払いは確定済みです" },
  review_required: { label: "確認が必要", pill: "s-yellow", title: "確認が必要な支払いです。店舗スタッフにお声がけください。" },
  expired: { label: "期限切れ", pill: "s-red", title: "この請求は期限切れです" },
  cancelled: { label: "無効", pill: "s-red", title: "この請求は無効です" },
};

const AUTO_STATUS_META = {
  issued: {
    pill: "s-blue",
    icon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 6v6l4 2" /><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" /></svg>',
  },
  open: {
    pill: "s-blue",
    icon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 6v6l4 2" /><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" /></svg>',
  },
  payment_detected: {
    pill: "s-blue",
    icon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 2v4" /><path d="M12 18v4" /><path d="m4.93 4.93 2.83 2.83" /><path d="m16.24 16.24 2.83 2.83" /><path d="M2 12h4" /><path d="M18 12h4" /></svg>',
  },
  confirming: {
    pill: "s-blue",
    icon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 2v4" /><path d="M12 18v4" /><path d="m4.93 4.93 2.83 2.83" /><path d="m16.24 16.24 2.83 2.83" /><path d="M2 12h4" /><path d="M18 12h4" /></svg>',
  },
  paid: {
    pill: "s-green",
    icon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M20 6 9 17l-5-5" /></svg>',
  },
  settled: {
    pill: "s-green",
    icon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M20 6 9 17l-5-5" /><path d="M4 20h16" /></svg>',
  },
  review_required: {
    pill: "s-yellow",
    icon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>',
  },
  expired: {
    pill: "s-red",
    icon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 6v6l3 2" /><path d="M12 22a10 10 0 1 0-8.5-4.7" /><path d="m3 22 3-3 3 3" /></svg>',
  },
  cancelled: {
    pill: "s-red",
    icon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M18 6 6 18" /><path d="m6 6 12 12" /><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" /></svg>',
  },
};

const state = {
  invoice: null,
  pollTimer: null,
  remainingTimer: null,
  pollInFlight: false,
  announcedMinute: "",
  manualRiskVisible: false,
  addressExpanded: false,
  manualActionHint: "",
  policyAcknowledged: false,
  policyAcknowledgementId: "",
};

const el = {
  liveStatus: document.getElementById("liveStatus"),
  errorBanner: document.getElementById("errorBanner"),
  errorBannerText: document.getElementById("errorBannerText"),
  errorBannerCloseBtn: document.getElementById("errorBannerCloseBtn"),
  receiptView: document.getElementById("receiptView"),
  mobilePayHeader: document.getElementById("mobilePayHeader"),
  mobileSummaryCard: document.querySelector(".mobile-summary-card"),
  amountHero: document.querySelector(".amount-hero"),
  mobilePageWrap: document.querySelector(".mobile-surface .wrap") || document.querySelector(".wrap"),
  mobileDisclosureStack: document.querySelector(".mobile-disclosure-stack:not(.receipt-disclosure-stack)"),
  mobileAutoStatusCard: document.getElementById("mobileAutoStatusCard"),
  mobileAutoStatusIcon: document.querySelector("#mobileAutoStatusCard .mobile-auto-status-icon"),
  mobileAutoStatusTime: document.getElementById("mobileAutoStatusTime"),
  statusPill: document.getElementById("statusPill"),
  storeText: document.getElementById("storeText"),
  merchantTrustBadge: document.getElementById("merchantTrustBadge"),
  issuedAtText: document.getElementById("issuedAtText"),
  amountText: document.getElementById("amountText"),
  amountSubText: document.getElementById("amountSubText"),
  mobileHeaderStoreName: document.getElementById("mobileHeaderStoreName"),
  summaryNetworkText: document.getElementById("summaryNetworkText"),
  summaryContractText: document.getElementById("summaryContractText"),
  summaryStoreText: document.getElementById("summaryStoreText"),
  expiresText: document.getElementById("expiresText"),
  remainingText: document.getElementById("remainingText"),
  uxStateLabel: document.getElementById("uxStateLabel"),
  uxStateDetail: document.getElementById("uxStateDetail"),
  methodPanel: document.getElementById("methodPanel"),
  methodPanelText: document.getElementById("methodPanelText"),
  customerActionCard: document.getElementById("customerActionCard"),
  customerActionBadge: document.getElementById("customerActionBadge"),
  customerActionTitle: document.getElementById("customerActionTitle"),
  customerActionBody: document.getElementById("customerActionBody"),
  customerActionList: document.getElementById("customerActionList"),
  supportedWalletChips: document.getElementById("supportedWalletChips"),
  walletPayBtn: document.getElementById("walletPayBtn"),
  walletDisabledReason: document.getElementById("walletDisabledReason"),
  showMethodsBtn: document.getElementById("showMethodsBtn"),
  copyInfoBtn: document.getElementById("copyInfoBtn"),
  networkText: document.getElementById("networkText"),
  toText: document.getElementById("toText"),
  invoiceText: document.getElementById("invoiceText"),
  txHashText: document.getElementById("txHashText"),
  copyAddressBtn: document.getElementById("copyAddressBtn"),
  copyAmountBtn: document.getElementById("copyAmountBtn"),
  copyInvoiceBtn: document.getElementById("copyInvoiceBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  paymentConditionsCard: document.getElementById("paymentConditionsCard"),
  paymentVerifyCard: document.getElementById("paymentVerifyCard"),
  verifyNetworkText: document.getElementById("verifyNetworkText"),
  verifyTokenText: document.getElementById("verifyTokenText"),
  verifyTokenContractText: document.getElementById("verifyTokenContractText"),
  verifyAddressText: document.getElementById("verifyAddressText"),
  manualRiskText: document.getElementById("manualRiskText"),
  policyConsentCheckbox: document.getElementById("policyConsentCheckbox"),
  toggleAddressBtn: document.getElementById("toggleAddressBtn"),
  receiptCard: document.getElementById("receiptCard"),
  receiptConfirmedText: document.getElementById("receiptConfirmedText"),
  receiptConfirmedAt: document.getElementById("receiptConfirmedAt"),
  receiptStatusText: document.getElementById("receiptStatusText"),
  receiptStoreName: document.getElementById("receiptStoreName"),
  receiptAmount: document.getElementById("receiptAmount"),
  receiptInvoiceId: document.getElementById("receiptInvoiceId"),
  receiptTxHash: document.getElementById("receiptTxHash"),
  receiptNetworkText: document.getElementById("receiptNetworkText"),
  receiptDetailNetworkText: document.getElementById("receiptDetailNetworkText"),
  receiptDetailContractText: document.getElementById("receiptDetailContractText"),
  receiptDetailToText: document.getElementById("receiptDetailToText"),
  downloadReceiptBtn: document.getElementById("downloadReceiptBtn"),
  copyReceiptInvoiceBtn: document.getElementById("copyReceiptInvoiceBtn"),
  copyReceiptTxBtn: document.getElementById("copyReceiptTxBtn"),
  copyReceiptToBtn: document.getElementById("copyReceiptToBtn"),
  showStaffBtn: document.getElementById("showStaffBtn"),
  policyTermsLink: document.getElementById("policyTermsLink"),
  policyPrivacyLink: document.getElementById("policyPrivacyLink"),
  policyRefundLink: document.getElementById("policyRefundLink"),
  paymentGuideDetails: document.querySelector(".payment-guide-details"),
  technicalDetails: document.getElementById("technicalDetails"),
};

function announce(message) {
  el.liveStatus.textContent = message || "";
}

function showError(message) {
  if (!el.errorBanner || !el.errorBannerText) return;
  if (!message) {
    el.errorBanner.classList.add("hidden");
    el.errorBannerText.textContent = "";
    return;
  }
  el.errorBanner.classList.remove("hidden");
  el.errorBannerText.textContent = message;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatJpy(value) {
  return `¥${toNumber(value).toLocaleString("ja-JP")}`;
}

function formatJpyc(value) {
  return `${toNumber(value).toLocaleString("ja-JP")} JPYC`;
}

function getTokenSymbol(invoice) {
  return String(invoice?.token_symbol || "JPYC");
}

function getNetwork(invoice) {
  return String(invoice?.network || (invoice?.chain_id === "137" ? "Polygon" : invoice?.chain_id || "-"));
}

function getTokenContract(invoice) {
  return String(invoice?.token_contract || invoice?.payment_chain?.token_contract_display || "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29");
}

function getContractSuffix(invoice) {
  const contract = getTokenContract(invoice);
  return contract.length > 10 ? `...${contract.slice(-5)}` : contract || "...C3c29";
}

function getReceiveAddress(invoice) {
  return String(invoice?.receive_address || invoice?.recipient_address || "");
}

function getCopyFallback(invoice) {
  return invoice?.copy_fallback || {};
}

function formatDateTime(value) {
  if (!value) return "-";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function renderChipGroup(host, values, fallback = "案内準備中") {
  host.innerHTML = "";
  const items = Array.isArray(values) && values.length > 0 ? values : [fallback];
  for (const value of items) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = String(value || fallback);
    host.appendChild(chip);
  }
}

function setHelperLink(linkEl, href, label) {
  if (!linkEl) return;
  if (typeof href === "string" && href.trim()) {
    linkEl.href = href.trim();
    linkEl.textContent = label;
    linkEl.classList.remove("hidden");
    return;
  }
  linkEl.classList.add("hidden");
  linkEl.removeAttribute("href");
}

function setPolicyLink(linkEl, href, label) {
  if (!linkEl) return;
  const url = typeof href === "string" ? href.trim() : "";
  linkEl.textContent = url ? label : `${label}（準備中）`;
  linkEl.setAttribute("aria-label", url ? `${label}（新しいタブで開く）` : `${label}は現在準備中です`);
  if (url) {
    linkEl.href = url;
    linkEl.target = "_blank";
    linkEl.rel = "noopener noreferrer";
    linkEl.removeAttribute("aria-disabled");
    linkEl.removeAttribute("title");
    return;
  }
  linkEl.removeAttribute("href");
  linkEl.removeAttribute("target");
  linkEl.removeAttribute("rel");
  linkEl.setAttribute("aria-disabled", "true");
  linkEl.title = `${label}のURLはまだ設定されていません。`;
}

function middleEllipsis(value, head = 10, tail = 8) {
  const text = String(value || "");
  if (!text || text.length <= head + tail + 1) return text || "-";
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function formatRemaining(expiresAt) {
  if (!expiresAt) return "期限情報を確認中です。";
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry)) return "期限情報を確認中です。";
  const remainMs = expiry - Date.now();
  if (remainMs <= 0) return "期限切れです。";
  const totalSec = Math.floor(remainMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `残り ${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function isInvoiceExpired(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status);
  if (status === "expired") return true;
  return WAITING_STATUSES.has(status) && formatRemaining(invoice?.expires_at) === "期限切れです。";
}

function shouldPoll(status) {
  return !FINAL_STATUSES.has(canonicalInvoiceStatus(status));
}

function canonicalInvoiceStatus(status) {
  const raw = String(status || "").trim();
  if (!raw) return "";
  return INVOICE_STATUS_ALIASES[raw] || raw;
}

function startPolling(status) {
  stopPolling();
  if (!shouldPoll(status)) return;
  state.pollTimer = setInterval(() => {
    void loadInvoice({ silent: true, fromPolling: true });
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function startRemainingTimer(invoice) {
  stopRemainingTimer();
  if (!invoice?.expires_at || !WAITING_STATUSES.has(canonicalInvoiceStatus(invoice?.status))) return;
  state.remainingTimer = setInterval(() => {
    updateRemainingAnnouncement(invoice.expires_at);
    if (formatRemaining(invoice.expires_at) === "期限切れです。") {
      updateExpiredNotice(invoice);
    }
  }, 1000);
}

function stopRemainingTimer() {
  if (!state.remainingTimer) return;
  clearInterval(state.remainingTimer);
  state.remainingTimer = null;
}

function signedInvoicePath() {
  if (!invoiceId || !sig || !exp || !nonce) return null;
  return `/api/v1/public/invoices/${encodeURIComponent(invoiceId)}?sig=${encodeURIComponent(sig)}&exp=${encodeURIComponent(exp)}&nonce=${encodeURIComponent(nonce)}`;
}

function signedPolicyAcknowledgementPath() {
  if (!invoiceId || !sig || !exp || !nonce) return null;
  return `/api/v1/public/invoices/${encodeURIComponent(invoiceId)}/consent?sig=${encodeURIComponent(sig)}&exp=${encodeURIComponent(exp)}&nonce=${encodeURIComponent(nonce)}`;
}

function initPolicyLinks() {
  const policy = state.invoice?.policy || {};
  const urls = {
    terms: policy.terms_url || POLICY_URLS.terms,
    privacy: policy.privacy_url || POLICY_URLS.privacy,
    refund: policy.refund_policy_url || POLICY_URLS.refund,
  };
  setPolicyLink(el.policyTermsLink, urls.terms, "利用規約");
  setPolicyLink(el.policyPrivacyLink, urls.privacy, "プライバシー");
  setPolicyLink(el.policyRefundLink, urls.refund, "返金ポリシー");
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function displayedPolicyHash() {
  const policy = state.invoice?.policy || {};
  const snapshot = {
    terms_url: policy.terms_url || POLICY_URLS.terms,
    privacy_url: policy.privacy_url || POLICY_URLS.privacy,
    refund_policy_url: policy.refund_policy_url || POLICY_URLS.refund,
    terms_version: policy.terms_version || POLICY_VERSIONS.terms_version,
    privacy_version: policy.privacy_version || POLICY_VERSIONS.privacy_version,
    refund_policy_version: policy.refund_policy_version || POLICY_VERSIONS.refund_policy_version,
  };
  return sha256Hex(JSON.stringify(snapshot));
}

async function recordPolicyAcknowledgement() {
  const path = signedPolicyAcknowledgementPath();
  if (!path) throw new Error("ポリシー確認記録URLが無効です。");
  const body = {
    acknowledged: true,
    displayed_policy_hash: await displayedPolicyHash(),
    client_rendered_at: new Date().toISOString(),
  };
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.policy_acknowledgement_id) {
    throw new Error(data?.error?.message || "ポリシー確認記録に失敗しました。");
  }
  state.policyAcknowledgementId = data.policy_acknowledgement_id;
}

async function ensurePolicyAcknowledgementRecorded() {
  if (state.policyAcknowledged && state.policyAcknowledgementId) return true;
  await recordPolicyAcknowledgement();
  state.policyAcknowledged = true;
  return true;
}

function buildWalletLaunchTarget(invoice) {
  if (!invoice) return null;
  const candidates = [
    { type: "wallet_deeplink", url: invoice.wallet_deeplink },
    { type: "payment_uri", url: invoice.payment_uri },
    { type: "wallet_url", url: invoice.wallet_url },
  ];
  for (const candidate of candidates) {
    if (typeof candidate.url === "string" && candidate.url.trim()) {
      return { type: candidate.type, url: candidate.url.trim() };
    }
  }
  return null;
}

function buildManualPaymentInstructions(invoice, options = {}) {
  const { includeHelp = false } = options;
  const fallback = getCopyFallback(invoice);
  const lines = [
    "ウォレットが自動起動しない場合は、以下の内容を手動で入力して送金してください。",
    `ネットワーク: ${fallback.copy_network || getNetwork(invoice) || "-"}`,
    `トークン: ${fallback.copy_token || getTokenSymbol(invoice) || "JPYC"}`,
    `支払い先: ${fallback.copy_receive_address || getReceiveAddress(invoice) || "-"}`,
  ];
  if (invoice?.amount_jpy != null) {
    lines.push(`請求金額: ${formatJpy(invoice.amount_jpy)}`);
  }
  if (invoice?.amount_jpyc != null) {
    lines.push(`送金額: ${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`);
  }
  if (includeHelp && invoice?.wallet_help_url) {
    lines.push(`ヘルプ: ${invoice.wallet_help_url}`);
  }
  return lines.join("\n");
}

function buildPaymentMethodHint(invoice) {
  const customerMode = invoice?.customer_payment_mode || {};
  if (customerMode.mode && customerMode.mode !== "wallet_qr") {
    return customerMode.body || "この会計は店頭端末でご案内します。スタッフの案内に従ってください。";
  }
  const adapter = invoice?.wallet_adapter || {};
  if (FINAL_STATUSES.has(canonicalInvoiceStatus(invoice?.status))) {
    return "この請求の受付は完了しています。";
  }
  if (buildWalletLaunchTarget(invoice)) {
    return "ウォレットアプリを開いて、支払い先と金額を確認して送金してください。";
  }
  if (adapter.reason) {
    return `ウォレット連携は現在利用できません（${adapter.reason}）。「支払い情報をコピー」または手動送金案内をご利用ください。`;
  }
  return "支払い情報をコピーするか、手動送金案内を確認して送金してください。";
}

function manualRiskMessage(invoice) {
  const adapter = invoice?.wallet_adapter || {};
  const reason = adapter.reason ? `（理由: ${adapter.reason}）` : "";
  return `ウォレット自動起動が利用できません${reason}。手動送金では、ウォレット画面のネットワーク・トークン・送金先・金額をこの画面と必ず目視照合してください。`;
}

function showManualRiskWarning(invoice) {
  const message = manualRiskMessage(invoice);
  state.manualRiskVisible = true;
  showError(message);
  if (el.manualRiskText) el.manualRiskText.textContent = message;
  if (el.paymentVerifyCard) {
    el.paymentVerifyCard.classList.remove("hidden");
    el.paymentVerifyCard.classList.add("attention-pulse");
    window.setTimeout(() => el.paymentVerifyCard.classList.remove("attention-pulse"), 1200);
  }
  announce("手動送金では金額、送金先、チェーンを必ず目視照合してください。");
}

function staffGuidanceMessage(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status);
  if (status === "review_required") {
    return "確認が必要な支払いです。追加送金せず、いまの状況・請求ID・支払い先を店舗スタッフに見せてください。";
  }
  if (status === "expired") {
    return "この請求は期限切れです。送金せず、請求IDを店舗スタッフに見せて再発行を依頼してください。";
  }
  if (status === "cancelled") {
    return "この請求は無効です。送金せず、店舗スタッフにこの画面を見せて新しい案内を受けてください。";
  }
  return "この画面を店舗スタッフに見せてください。";
}

function showStaffGuidance(invoice) {
  if (isInvoiceExpired(invoice)) {
    updateExpiredNotice(invoice);
    setMethodPanel(false);
    (el.mobileAutoStatusCard || el.mobileSummaryCard)?.scrollIntoView({ behavior: "smooth", block: "center" });
    showError("");
    announce("この請求は期限切れです。送金せず、店舗スタッフに再発行を依頼してください。");
    return;
  }
  setMethodPanel(false, "");
  if (el.technicalDetails) el.technicalDetails.open = true;
  const target = el.customerActionCard || el.mobileAutoStatusCard || el.technicalDetails;
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  showError("");
  announce("店舗スタッフに見せる案内を表示しました");
}

function renderWalletSupport(invoice) {
  if (!el.supportedWalletChips) {
    return;
  }
  const customerMode = invoice?.customer_payment_mode || {};
  if (customerMode.mode && customerMode.mode !== "wallet_qr") {
    renderChipGroup(el.supportedWalletChips, ["店頭端末でご案内"], "店頭端末でご案内");
    return;
  }
  const supportedWallets = Array.isArray(invoice?.supported_wallets) ? invoice.supported_wallets : [];
  renderChipGroup(el.supportedWalletChips, supportedWallets, "確認中");
}

function renderCustomerAction(invoice) {
  if (
    !el.customerActionCard ||
    !el.customerActionBadge ||
    !el.customerActionTitle ||
    !el.customerActionBody ||
    !el.customerActionList
  ) {
    return;
  }
  const status = canonicalInvoiceStatus(invoice?.status) || "issued";
  el.customerActionCard.classList.remove("hidden");
  const customerMode = invoice?.customer_payment_mode || {};
  if (customerMode.mode && customerMode.mode !== "wallet_qr") {
    el.customerActionBadge.textContent =
      customerMode.mode === "tap_processing"
        ? "確認中"
        : customerMode.mode === "tap_retry"
          ? "再案内"
          : customerMode.mode === "tap_review"
            ? "要確認"
            : "店頭案内";
    el.customerActionTitle.textContent = customerMode.title || "店頭端末でご案内します";
    el.customerActionBody.textContent = customerMode.body || "スタッフの案内に従ってください。";
    el.customerActionList.innerHTML = "";
    for (const item of [
      "この会計は店頭端末でご案内します。",
      "ウォレット送金へは切り替えず、スタッフの案内に従ってください。",
      customerMode.mode === "tap_processing" ? "状態更新まではそのままお待ちください。" : "長く進まない場合は店舗スタッフへお声がけください。",
    ]) {
      const li = document.createElement("li");
      li.textContent = item;
      el.customerActionList.appendChild(li);
    }
    state.manualActionHint = customerMode.body || "";
    return;
  }
  const hasLaunchTarget = Boolean(buildWalletLaunchTarget(invoice));
  const actionMap = {
    issued: {
      badge: "支払い前",
      title: "店舗確認がしやすい手順で送金してください",
      body: hasLaunchTarget
        ? "メインボタンからウォレットを開き、JPYC・金額・送金先がこの画面と一致することを確認して送金します。"
        : "ウォレット起動が使えない場合は、支払い情報をコピーして手動で送金してください。",
      items: [
        "送金先と金額はこの画面の内容と一致していることを確認します。",
        "送金後はこの画面に戻り、自動更新を待ちます。",
        "秘密鍵やシードフレーズの入力は不要です。",
      ],
    },
    open: {
      badge: "支払い前",
      title: "店舗確認がしやすい手順で送金してください",
      body: hasLaunchTarget
        ? "支払いボタンからウォレットを開き、そのまま送金してください。"
        : "コピーした支払い情報をウォレットへ貼り付けて送金してください。",
      items: [
        "送金は 1 回だけ行います。",
        "送金後はこの画面の状態が変わるまで待ちます。",
        "分からない場合は店舗スタッフにお声がけください。",
      ],
    },
    payment_detected: {
      badge: "確認中",
      title: "送金は受け付け済みです。このままお待ちください",
      body: "状態更新中のため、追加送金や再送信は行わず、そのまま待機してください。",
      items: [
        "二重送信は不要です。",
        "画面は自動更新されます。",
        "長く変わらない場合は店舗スタッフへお声がけください。",
      ],
    },
    confirming: {
      badge: "確認中",
      title: "オンチェーン確認中です",
      body: "送金後の確認中です。処理が完了するまで数十秒ほどかかる場合があります。",
      items: [
        "追加送金は行わずに待ちます。",
        "この画面を開いたままにします。",
        "困ったときは店舗スタッフに声をかけてください。",
      ],
    },
    paid: {
      badge: "完了",
      title: "支払いを確認しました",
      body: "この画面の表示が変わったら支払い完了です。店舗側の照合を早めるため、必要があればスタッフへ画面をお見せください。",
      items: [
        "再送金は不要です。",
        "店舗側の案内に従ってください。",
        "詳細情報には請求 ID と取引番号を表示できます。",
      ],
    },
    settled: {
      badge: "完了",
      title: "支払いは確定済みです",
      body: "処理は完了しています。追加操作は不要です。",
      items: [
        "必要な確認が終わっていれば画面を閉じて問題ありません。",
        "請求 ID は明細確認に使えます。",
        "不明点があれば店舗スタッフにお声がけください。",
      ],
    },
    review_required: {
      badge: "要確認",
      title: "店舗スタッフへお声がけください",
      body: "お支払い内容の確認が必要です。追加で送金せず、店舗スタッフにこの画面を見せてください。",
      items: [
        "追加送金は行わないでください。",
        "この画面の内容をスタッフに見せてください。",
        "店舗側で確認します。",
      ],
    },
    expired: {
      badge: "再発行",
      title: "この請求は期限切れです",
      body: "新しい請求を発行する必要があります。店舗スタッフに再発行を依頼してください。",
      items: [
        "古い QR や古い請求 ID は使わないでください。",
        "新しい請求が出るまで送金しません。",
        "期限後に送金してしまった場合はスタッフへお知らせください。",
      ],
    },
    cancelled: {
      badge: "無効",
      title: "この請求は無効です",
      body: "この請求では支払えません。店舗スタッフへ新しい請求を依頼してください。",
      items: [
        "この請求への送金はしないでください。",
        "必要なら新しい QR を受け取ってください。",
        "不明点があればスタッフへお声がけください。",
      ],
    },
  };

  const action = actionMap[status] || actionMap.issued;
  el.customerActionBadge.textContent = action.badge;
  el.customerActionTitle.textContent = action.title;
  el.customerActionBody.textContent = action.body;
  el.customerActionList.innerHTML = "";
  for (const item of action.items) {
    const li = document.createElement("li");
    li.textContent = item;
    el.customerActionList.appendChild(li);
  }
  state.manualActionHint = action.body;
}

function updateRemainingAnnouncement(expiresAt) {
  const remaining = formatRemaining(expiresAt);
  el.remainingText.textContent = remaining;
  el.remainingText.classList.toggle("remaining-expired-label", remaining === "期限切れです。");
  const minuteKey = remaining.replace(/秒$/, "");
  if (minuteKey !== state.announcedMinute) {
    state.announcedMinute = minuteKey;
    if (minuteKey.includes("残り")) {
      announce(`支払い期限 ${minuteKey}`);
    }
  }
}

function updateExpiredNotice(invoice) {
  const expired = isInvoiceExpired(invoice);
  el.remainingText?.classList.toggle("hidden", expired);
  if (expired) setMethodPanel(false);
  if (expired) {
    el.statusPill.textContent = "期限切れ";
    el.statusPill.className = "status-pill s-red";
  }
}

function positionAutoStatusCard(invoice) {
  if (!el.mobileAutoStatusCard) return;
  if (isInvoiceExpired(invoice) && el.amountHero) {
    el.amountHero.after(el.mobileAutoStatusCard);
    return;
  }
  if (el.mobilePageWrap && el.mobileAutoStatusCard.parentElement !== el.mobilePageWrap) {
    el.mobilePageWrap.appendChild(el.mobileAutoStatusCard);
  }
}

function renderPaymentConditions(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status) || "issued";
  const show = WAITING_STATUSES.has(status);
  el.paymentConditionsCard.classList.toggle("hidden", !show);
}

function renderPaymentVerification(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status) || "issued";
  const show = WAITING_STATUSES.has(status);
  if (!el.paymentVerifyCard) return;
  el.paymentVerifyCard.classList.toggle("hidden", !show);
  if (!show) return;
  const network = getNetwork(invoice) || "Polygon";
  const chainId = invoice?.chain_id || "137";
  const token = getTokenSymbol(invoice) || "JPYC";
  const contract = getTokenContract(invoice);
  const receiveAddress = getReceiveAddress(invoice);
  el.verifyNetworkText.textContent = `${network}（チェーンID: ${chainId}）`;
  el.verifyTokenText.textContent = token;
  if (el.verifyTokenContractText) el.verifyTokenContractText.textContent = contract;
  el.verifyAddressText.textContent = receiveAddress || "-";
  el.verifyAddressText.title = receiveAddress || "";
  if (el.manualRiskText && !state.manualRiskVisible) {
    el.manualRiskText.textContent = `ウォレット画面で「${network}」「JPYC」「公式コントラクト ${getContractSuffix(invoice)}」「この画面の送金先」が一致していることを確認してから送信してください。`;
  }
}

function renderReceiptCard(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status);
  initPolicyLinks();
  const isPaid = status === "paid" || status === "settled";
  el.receiptView.classList.toggle("hidden", !isPaid);
  el.mobilePayHeader?.classList.toggle("hidden", isPaid);
  el.mobileSummaryCard?.classList.toggle("hidden", isPaid);
  el.mobileDisclosureStack?.classList.toggle("hidden", isPaid);
  el.mobileAutoStatusCard?.classList.toggle("hidden", isPaid);
  if (!isPaid) return;
  const statusLabel = status === "settled" ? "確定済み" : "支払い確認済み";
  const confirmedAt = invoice.paid_at || invoice.block_timestamp || invoice.verified_at || invoice.updated_at || new Date().toISOString();
  el.receiptConfirmedText.textContent = status === "settled" ? "支払いは確定済みです" : "受領を確認しました";
  el.receiptConfirmedAt.textContent = formatDateTime(confirmedAt);
  el.receiptStatusText.textContent = statusLabel;
  el.receiptStoreName.textContent = invoice.store_name || "加盟店";
  el.receiptAmount.textContent =
    `${formatJpy(invoice.amount_jpy)} / ${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`;
  el.receiptInvoiceId.textContent = invoice.invoice_no || invoice.invoice_id || "-";
  el.receiptTxHash.textContent = invoice.paid_tx_hash || "-";
  el.receiptNetworkText.textContent = getNetwork(invoice);
  el.receiptDetailNetworkText.textContent = getNetwork(invoice);
  if (el.receiptDetailContractText) el.receiptDetailContractText.textContent = getTokenContract(invoice);
  el.receiptDetailToText.textContent = getReceiveAddress(invoice) || "-";
  el.receiptDetailToText.title = getReceiveAddress(invoice) || "";
}

function renderStatus(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status);
  const unknownStatus = !STATUS_COPY[status];
  const meta = STATUS_COPY[status] || {
    label: "状態確認中",
    pill: "s-gray",
    title: "支払い状況を確認中です。",
  };
  el.statusPill.textContent = meta.label;
  el.statusPill.className = `status-pill ${meta.pill}`;
  el.uxStateLabel.textContent = meta.title;
  if (el.mobileAutoStatusCard) {
    const autoMeta = AUTO_STATUS_META[status] || { pill: "s-gray", icon: "" };
    el.mobileAutoStatusCard.classList.remove("s-blue", "s-green", "s-yellow", "s-red", "s-gray");
    el.mobileAutoStatusCard.classList.add(autoMeta.pill);
    if (el.mobileAutoStatusIcon) {
      el.mobileAutoStatusIcon.classList.remove("s-blue", "s-green", "s-yellow", "s-red", "s-gray");
      el.mobileAutoStatusIcon.classList.add(autoMeta.pill);
      if (autoMeta.icon) el.mobileAutoStatusIcon.innerHTML = autoMeta.icon;
    }
  }
  if (unknownStatus) {
    el.uxStateDetail.textContent = "不明な状態です。確認のため自動更新を継続しています。";
    return;
  }
  el.uxStateDetail.textContent = state.manualActionHint || "";
}

function renderInvoice(invoice) {
  state.invoice = invoice;
  state.manualActionHint = buildPaymentMethodHint(invoice);
  const status = canonicalInvoiceStatus(invoice?.status);

  el.storeText.textContent = invoice.store_name || "加盟店";
  if (el.mobileHeaderStoreName) el.mobileHeaderStoreName.textContent = invoice.store_name || "";
  if (el.merchantTrustBadge) el.merchantTrustBadge.textContent = invoice.store_name ? "サーバー発行済み" : "発行元確認中";
  if (el.issuedAtText) el.issuedAtText.textContent = formatDateTime(invoice.issued_at || invoice.created_at);
  el.amountText.textContent = `${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`;
  el.amountSubText.textContent = formatJpy(invoice.amount_jpy);
  if (el.summaryNetworkText) el.summaryNetworkText.textContent = getNetwork(invoice);
  if (el.summaryContractText) el.summaryContractText.textContent = getContractSuffix(invoice);
  if (el.summaryStoreText) el.summaryStoreText.textContent = invoice.store_name || "加盟店";
  el.expiresText.textContent = formatDateTime(invoice.expires_at);
  updateRemainingAnnouncement(invoice.expires_at);
  updateExpiredNotice(invoice);

  renderCustomerAction(invoice);
  renderWalletSupport(invoice);
  renderPaymentConditions(invoice);
  renderPaymentVerification(invoice);
  renderReceiptCard(invoice);
  renderStatus(invoice);
  positionAutoStatusCard(invoice);
  updateExpiredNotice(invoice);

  el.networkText.textContent = getNetwork(invoice);
  const receiveAddress = getReceiveAddress(invoice);
  el.toText.textContent = state.addressExpanded ? (receiveAddress || "-") : middleEllipsis(receiveAddress);
  el.toText.title = receiveAddress || "";
  el.invoiceText.textContent = invoice.invoice_no || invoice.invoice_id || "-";
  el.txHashText.textContent = invoice.paid_tx_hash || "-";

  const customerMode = invoice?.customer_payment_mode || {};
  const paymentActionAvailable = PAYMENT_INITIATION_STATUSES.has(status) && (!customerMode.mode || customerMode.mode === "wallet_qr");
  const isReceiptMode = status === "paid" || status === "settled";
  const needsStaff = STAFF_STATUSES.has(status);
  const inConfirmingState = WAITING_STATUSES.has(status) && !PAYMENT_INITIATION_STATUSES.has(status);
  const consentChecked = el.policyConsentCheckbox ? el.policyConsentCheckbox.checked : true;
  const walletAllowed = paymentActionAvailable && consentChecked;
  const copyAllowed = Boolean(invoice) && !isReceiptMode && !inConfirmingState && consentChecked;
  const primaryActionAllowed = walletAllowed || needsStaff;
  if (el.paymentGuideDetails) el.paymentGuideDetails.classList.toggle("hidden", needsStaff || isReceiptMode);
  if (needsStaff) setMethodPanel(false, "");
  const primaryActionStack = el.walletPayBtn?.closest(".primary-action-stack");
  if (primaryActionStack) primaryActionStack.classList.toggle("hidden", isReceiptMode);
  if (needsStaff) {
    el.walletPayBtn.innerHTML = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M8 4H5a1 1 0 0 0-1 1v3" /><path d="M16 4h3a1 1 0 0 1 1 1v3" /><path d="M20 16v3a1 1 0 0 1-1 1h-3" /><path d="M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M7 12h10" /></svg><span>スタッフに見せる</span>';
  } else {
    el.walletPayBtn.innerHTML = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></svg><span>ウォレットで支払う</span>';
  }
  el.walletPayBtn.disabled = !primaryActionAllowed;
  el.walletPayBtn.classList.toggle("is-ready", primaryActionAllowed);
  el.showMethodsBtn.disabled = !walletAllowed;
  el.copyInfoBtn.disabled = !copyAllowed;
  el.copyAddressBtn.disabled = !copyAllowed;
  el.copyAmountBtn.disabled = !copyAllowed;
  el.copyInvoiceBtn.disabled = !copyAllowed;
  if (el.toggleAddressBtn) {
    el.toggleAddressBtn.disabled = !receiveAddress;
    el.toggleAddressBtn.textContent = state.addressExpanded ? "支払い先を短縮表示" : "支払い先を全文表示";
  }
  if (el.walletDisabledReason) {
    let reason = "";
    const expiredDisplay = isInvoiceExpired(invoice);
    if (isReceiptMode) {
      reason = "支払い確認済みです。確認書をコピーできます。";
    } else if (WAITING_STATUSES.has(status) && !paymentActionAvailable) {
      reason = "支払いを確認中です。追加で送金しないでください。";
    } else if (!paymentActionAvailable) {
      reason = needsStaff
        ? "この状態では送金せず、画面を店舗スタッフに見せてください。"
        : "現在の状態では支払い操作を開始できません。";
    } else if (!consentChecked) {
      reason = "上のチェックボックスにチェックを入れてから進んでください。";
    } else {
      reason = "金額・ネットワーク・送金先を確認してから進んでください。";
    }
    el.walletDisabledReason.textContent = reason;
    el.walletDisabledReason.classList.toggle("hidden", expiredDisplay || (walletAllowed && !needsStaff));
  }
  if (el.mobileAutoStatusTime) {
    const checkedAt = new Date().toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    });
    el.mobileAutoStatusTime.textContent = `最終確認 ${checkedAt}`;
  }
  startPolling(status);
  startRemainingTimer(invoice);
}

function buildCopyPayload(invoice) {
  const fallback = getCopyFallback(invoice);
  const lines = [
    `店舗: ${invoice.store_name || "加盟店"}`,
    `請求ID: ${invoice.invoice_no || invoice.invoice_id || "-"}`,
    `金額: ${formatJpy(invoice.amount_jpy)} (${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)})`,
    `支払いネットワーク: ${fallback.copy_network || getNetwork(invoice) || "-"}`,
    `支払い通貨: ${fallback.copy_token || getTokenSymbol(invoice)}`,
    `支払い先: ${fallback.copy_receive_address || getReceiveAddress(invoice) || "-"}`,
    `送金額: ${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`,
    `期限: ${formatDateTime(invoice.expires_at)}`,
  ];
  return lines.join("\n");
}

async function copyText(text) {
  const value = String(text || "");
  if (!value) throw new Error("コピー対象がありません");
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to the selection-based copy path when browser permissions deny clipboard writes.
    }
  }
  const temp = document.createElement("textarea");
  temp.value = value;
  temp.setAttribute("readonly", "true");
  temp.style.position = "fixed";
  temp.style.opacity = "0";
  document.body.appendChild(temp);
  temp.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(temp);
  if (!ok) throw new Error("コピーに失敗しました");
}

function setMethodPanel(visible, message = "") {
  el.methodPanel.classList.toggle("hidden", !visible);
  el.methodPanelText.textContent = message;
}

async function handleWalletPay() {
  const invoice = state.invoice;
  if (!invoice) {
    showError("請求情報を読み込み中です。");
    return;
  }
  if (STAFF_STATUSES.has(canonicalInvoiceStatus(invoice.status))) {
    showStaffGuidance(invoice);
    return;
  }
  if (invoice.customer_payment_mode?.mode && invoice.customer_payment_mode.mode !== "wallet_qr") {
    setMethodPanel(true, invoice.customer_payment_mode.body || "この会計は店頭端末でご案内します。");
    announce("店頭端末の案内をご確認ください");
    return;
  }
  if (!PAYMENT_INITIATION_STATUSES.has(canonicalInvoiceStatus(invoice.status))) {
    showError("現在の状態ではお支払いを開始できません。");
    return;
  }
  try {
    await ensurePolicyAcknowledgementRecorded();
  } catch (error) {
    showError(String(error.message || error));
    announce("支払い前の記録に失敗しました");
    return;
  }
  const launchTarget = buildWalletLaunchTarget(invoice);
  if (!launchTarget) {
    showManualRiskWarning(invoice);
    setMethodPanel(true, buildManualPaymentInstructions(invoice, { includeHelp: true }));
    announce("手動送金の案内を表示しました");
    return;
  }
  setMethodPanel(true, "ウォレットを開きます。金額と送金先を確認してから送金してください。");
  announce("ウォレットを開きます");
  location.href = launchTarget.url;
}

async function handleCopyInfo() {
  if (!state.invoice) return;
  try {
    await ensurePolicyAcknowledgementRecorded();
  } catch (error) {
    showError(String(error.message || error));
    return;
  }
  try {
    await copyText(buildCopyPayload(state.invoice));
    const status = canonicalInvoiceStatus(state.invoice.status);
    setMethodPanel(
      true,
      PAYMENT_INITIATION_STATUSES.has(status)
        ? "支払い情報をコピーしました。ウォレットで内容を確認して送金してください。"
        : "請求情報をコピーしました。送金せず、店舗スタッフへの確認に使ってください。"
    );
    announce("支払い情報をコピーしました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

async function handleCopyAddress() {
  if (!state.invoice) return;
  try {
    await ensurePolicyAcknowledgementRecorded();
  } catch (error) {
    showError(String(error.message || error));
    return;
  }
  try {
    await copyText(getCopyFallback(state.invoice).copy_receive_address || getReceiveAddress(state.invoice) || "");
    announce("支払い先をコピーしました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

async function handleCopyAmount() {
  if (!state.invoice) return;
  try {
    await ensurePolicyAcknowledgementRecorded();
  } catch (error) {
    showError(String(error.message || error));
    return;
  }
  try {
    await copyText(`${toNumber(state.invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(state.invoice)}`);
    announce("金額をコピーしました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

async function handleCopyInvoice() {
  if (!state.invoice) return;
  try {
    await ensurePolicyAcknowledgementRecorded();
  } catch (error) {
    showError(String(error.message || error));
    return;
  }
  try {
    await copyText(state.invoice.invoice_no || state.invoice.invoice_id || "");
    announce("請求IDをコピーしました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

function escapeReceiptHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function receiptFileName(invoice) {
  const reference = String(invoice?.invoice_no || invoice?.invoice_id || "payment-confirmation")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "payment-confirmation";
  return `payment-confirmation-${reference}.html`;
}

function buildReceiptDownloadHtml(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status);
  const statusLabel = status === "settled" ? "支払い確定済み" : "支払い確認済み";
  const confirmedAt = invoice?.paid_at || invoice?.block_timestamp || invoice?.verified_at || invoice?.updated_at || new Date().toISOString();
  const amount = `${formatJpy(invoice?.amount_jpy)} / ${toNumber(invoice?.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`;
  const rows = [
    ["店舗名", invoice?.store_name || "加盟店"],
    ["お支払い金額", amount],
    ["請求ID", invoice?.invoice_no || invoice?.invoice_id || "-"],
    ["取引参照", invoice?.paid_tx_hash || "-"],
    ["ネットワーク", getNetwork(invoice)],
    ["支払い先", getReceiveAddress(invoice) || "-"],
    ["確認日時", formatDateTime(confirmedAt)],
    ["ステータス", statusLabel],
  ];
  const rowHtml = rows.map(([label, value]) => `
      <tr>
        <th>${escapeReceiptHtml(label)}</th>
        <td>${escapeReceiptHtml(value)}</td>
      </tr>`).join("");
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>支払い確認書 ${escapeReceiptHtml(invoice?.invoice_no || invoice?.invoice_id || "")}</title>
  <style>
    body { margin: 0; padding: 32px; color: #12213a; background: #f6f8fc; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif; font-size: ${steppedReceiptPx(16)}; }
    main { max-width: 760px; margin: 0 auto; padding: 32px; border: 1px solid #cfe8d8; border-radius: 18px; background: #fff; }
    h1 { margin: 0 0 8px; color: #107546; font-size: ${steppedReceiptPx(34)}; }
    .lead { margin: 0 0 28px; color: #4a5870; font-size: ${steppedReceiptPx(16)}; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; }
    th, td { padding: 14px 0; border-bottom: 1px solid #d4dce9; text-align: left; vertical-align: top; font-size: ${steppedReceiptPx(16)}; }
    th { width: 150px; color: #5a6a82; }
    td { font-weight: 700; overflow-wrap: anywhere; }
    .amount { color: #12213a; font-size: ${steppedReceiptPx(24)}; font-weight: 900; }
    .note { margin-top: 28px; padding: 16px; border-radius: 12px; background: #eefaf3; color: #23543b; font-size: ${steppedReceiptPx(14)}; line-height: 1.7; }
  </style>
</head>
<body>
  <main>
    <h1>支払い確認書</h1>
    <p class="lead">JPYCでのお支払いを確認しました。</p>
    <table>
      <tbody>${rowHtml}</tbody>
    </table>
    <p class="note">この支払い確認書はお客様向けの支払い確認用です。返金や送金は店舗側で別途確認されます。この画面・ファイルが秘密鍵、シードフレーズ、署名権限を扱うことはありません。</p>
  </main>
</body>
</html>`;
}

function handleDownloadReceipt() {
  const invoice = state.invoice;
  if (!invoice) return;
  try {
    const blob = new Blob([buildReceiptDownloadHtml(invoice)], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = receiptFileName(invoice);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce("支払い確認書を保存しました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

async function handleCopyReceiptInvoice() {
  if (!state.invoice) return;
  try {
    await copyText(state.invoice.invoice_no || state.invoice.invoice_id || "");
    announce("請求IDをコピーしました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

async function handleCopyReceiptTx() {
  if (!state.invoice) return;
  try {
    await copyText(state.invoice.paid_tx_hash || "");
    announce("取引参照をコピーしました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

async function handleCopyReceiptTo() {
  if (!state.invoice) return;
  try {
    await copyText(getReceiveAddress(state.invoice) || "");
    announce("支払い先をコピーしました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

async function loadInvoice(options = {}) {
  const { silent = false, fromPolling = false } = options;
  if (state.pollInFlight && fromPolling) return;
  const path = signedInvoicePath();
  if (!path) {
    stopPolling();
    showError("このURLは無効です。");
    el.walletPayBtn.disabled = true;
    el.walletPayBtn.classList.remove("is-ready");
    return;
  }
  state.pollInFlight = true;
  try {
    const response = await fetch(path);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || "請求情報を取得できませんでした。";
      throw new Error(message);
    }
    showError("");
    renderInvoice(data);
    if (!silent) announce(`現在の状態は ${el.statusPill.textContent} です`);
  } catch (error) {
    showError(`請求情報の読み込みに失敗しました。${String(error.message || error)}`);
    setMethodPanel(true, "読み込みに失敗しました。時間をおいて再度お試しください。");
    el.walletPayBtn.disabled = true;
    el.walletPayBtn.classList.remove("is-ready");
    el.showMethodsBtn.disabled = true;
    el.copyInfoBtn.disabled = true;
    if (el.walletDisabledReason) el.walletDisabledReason.textContent = "請求情報を読み込めないため、支払い操作は開始できません。";
    if (!silent) announce("請求情報の取得に失敗しました");
  } finally {
    state.pollInFlight = false;
  }
}

function bindEvents() {
  if (el.errorBannerCloseBtn) {
    el.errorBannerCloseBtn.addEventListener("click", () => {
      showError("");
      announce("エラー表示を閉じました");
    });
  }
  if (el.policyConsentCheckbox) {
    el.policyConsentCheckbox.addEventListener("change", () => {
      if (state.invoice) renderInvoice(state.invoice);
    });
  }
  el.walletPayBtn.addEventListener("click", () => void handleWalletPay());
  el.showMethodsBtn.addEventListener("click", async () => {
    try {
      await ensurePolicyAcknowledgementRecorded();
    } catch (error) {
      showError(String(error.message || error));
      return;
    }
    const visible = el.methodPanel.classList.contains("hidden");
    setMethodPanel(visible, visible ? buildManualPaymentInstructions(state.invoice, { includeHelp: true }) : "");
    if (visible && state.invoice && !buildWalletLaunchTarget(state.invoice)) showManualRiskWarning(state.invoice);
    announce(visible ? "支払い方法を表示しました" : "支払い方法を閉じました");
  });
  el.copyInfoBtn.addEventListener("click", () => void handleCopyInfo());
  el.copyAddressBtn.addEventListener("click", () => void handleCopyAddress());
  el.copyAmountBtn.addEventListener("click", () => void handleCopyAmount());
  el.copyInvoiceBtn.addEventListener("click", () => void handleCopyInvoice());
  el.downloadReceiptBtn.addEventListener("click", () => handleDownloadReceipt());
  if (el.copyReceiptInvoiceBtn) el.copyReceiptInvoiceBtn.addEventListener("click", () => void handleCopyReceiptInvoice());
  if (el.copyReceiptTxBtn) el.copyReceiptTxBtn.addEventListener("click", () => void handleCopyReceiptTx());
  if (el.copyReceiptToBtn) el.copyReceiptToBtn.addEventListener("click", () => void handleCopyReceiptTo());
  if (el.showStaffBtn) {
    el.showStaffBtn.addEventListener("click", () => {
      const target = el.receiptCard || el.receiptView;
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      announce("確認書の金額、請求ID、取引番号を店舗スタッフに見せてください");
    });
  }
  el.refreshBtn.addEventListener("click", () => void loadInvoice({ silent: false }));
  if (el.toggleAddressBtn) {
    el.toggleAddressBtn.addEventListener("click", () => {
      state.addressExpanded = !state.addressExpanded;
      if (state.invoice) renderInvoice(state.invoice);
    });
  }
  window.addEventListener("beforeunload", () => {
    stopPolling();
    stopRemainingTimer();
  });
}

for (const button of [
  el.walletPayBtn,
  el.showMethodsBtn,
  el.copyInfoBtn,
  el.copyAddressBtn,
  el.copyAmountBtn,
  el.copyInvoiceBtn,
]) {
  if (button) button.disabled = true;
}

bindEvents();
initPolicyLinks();
setMethodPanel(false, "");
void loadInvoice({ silent: false });
