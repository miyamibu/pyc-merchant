const query = new URLSearchParams(location.search);
const invoiceId = query.get("invoiceId");
const sig = query.get("sig");
const exp = query.get("exp");
const nonce = query.get("nonce");

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

function applyPolicySnapshot(invoice) {
  const urls = invoice?.policy_urls;
  const versions = invoice?.policy_versions;
  if (urls && typeof urls === "object") Object.assign(POLICY_URLS, urls);
  if (versions && typeof versions === "object") Object.assign(POLICY_VERSIONS, versions);
  initPolicyLinks();
}

const INVOICE_STATUS_ALIASES = Object.freeze({
  manual_review: "review_required",
});

const POLL_INTERVAL_MS = 5000;
const OBSERVATION_FRESHNESS_MS = 30_000;
const MOBILE_REQUEST_TIMEOUT_MS = 10_000;
const INITIAL_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000]);
const REMAINING_ANNOUNCEMENT_THRESHOLDS_SEC = [300, 120, 60, 30, 10, 0];
// A paid/settled invoice remains observable because a later chain reorg can
// invalidate the fulfillment decision. Only an explicitly cancelled invoice
// is terminal for the public customer view.
const FINAL_STATUSES = new Set(["cancelled"]);
const WAITING_STATUSES = new Set(["issued", "open", "payment_detected", "confirming"]);
const PAYMENT_ACTION_STATUSES = new Set(["issued", "open"]);
const WALLET_LAUNCH_PROTOCOLS = new Set(["https:", "ethereum:", "hashport:", "wallet:", "wc:"]);
const WALLET_SCOPED_CAPABILITY_PREFIX = /^(?:検証済み環境（[^）]*(?:iOS|Android)[^）]*ウォレット[^）]*）|起動導線あり(?:（[^）]*）)?|手動送金のみ|未検証(?:（[^）]*）)?):\s*/;
const WALLET_BROAD_TESTED_PREFIX = /^実機検証済み:\s*(.+)$/;
const WALLET_RECOVERY_DELAY_MS = 1800;

const STATUS_COPY = {
  issued: { label: "支払い待ち", pill: "s-blue", title: "送金をお待ちしています" },
  open: { label: "支払い待ち", pill: "s-blue", title: "送金をお待ちしています" },
  payment_detected: { label: "確認中", pill: "s-blue", title: "支払いを確認中です" },
  confirming: { label: "確認中", pill: "s-blue", title: "支払いを確認中です" },
  paid: { label: "支払い確認済み", pill: "s-green", title: "支払いを確認しました" },
  settled: { label: "支払い確認済み", pill: "s-green", title: "支払いを確認しました" },
  review_required: { label: "確認が必要", pill: "s-yellow", title: "確認が必要な支払いです。店舗スタッフにお声がけください。" },
  expired: { label: "期限切れ", pill: "s-red", title: "この請求は期限切れです" },
  cancelled: { label: "無効", pill: "s-red", title: "この請求は無効です" },
};

const state = {
  invoice: null,
  pollTimer: null,
  remainingTimer: null,
  pollInFlight: false,
  announcedRemainingThreshold: null,
  lastAnnouncementInvoiceId: "",
  manualRiskVisible: false,
  addressExpanded: false,
  manualActionHint: "",
  consented: false,
  consentRecordStatus: "idle",
  consentRecordError: "",
  consentSequence: 0,
  consentController: null,
  lastRefreshSucceeded: false,
  lastRefreshInvoiceId: "",
  lastRefreshAtMs: 0,
  observationFreshnessTimer: null,
  refreshSequence: 0,
  refreshController: null,
  refreshInProgress: false,
  recoverySubmitting: false,
  serverClockOffsetMs: null,
  launchInProgress: false,
  blockingWarning: "",
  transientError: "",
  automaticRetryCount: 0,
  automaticRetryTimer: null,
  methodPanelReturnFocus: null,
  storeTimezone: "UTC",
  recoveryChains: [],
};

const el = {
  liveStatus: document.getElementById("liveStatus"),
  errorBanner: document.getElementById("errorBanner"),
  errorBannerText: document.getElementById("errorBannerText"),
  closeErrorBannerBtn: document.getElementById("closeErrorBannerBtn"),
  retryLoadBtn: document.getElementById("retryLoadBtn"),
  statusPill: document.getElementById("statusPill"),
  storeText: document.getElementById("storeText"),
  merchantTrustBadge: document.getElementById("merchantTrustBadge"),
  issuedAtText: document.getElementById("issuedAtText"),
  amountText: document.getElementById("amountText"),
  amountSubText: document.getElementById("amountSubText"),
  expiresText: document.getElementById("expiresText"),
  remainingText: document.getElementById("remainingText"),
  uxStateLabel: document.getElementById("uxStateLabel"),
  uxStateDetail: document.getElementById("uxStateDetail"),
  methodPanel: document.getElementById("methodPanel"),
  methodPanelText: document.getElementById("methodPanelText"),
  closeMethodsBtn: document.getElementById("closeMethodsBtn"),
  customerActionBadge: document.getElementById("customerActionBadge"),
  customerActionTitle: document.getElementById("customerActionTitle"),
  customerActionBody: document.getElementById("customerActionBody"),
  customerActionList: document.getElementById("customerActionList"),
  paymentRecoveryDetails: document.getElementById("paymentRecoveryDetails"),
  recoveryChainId: document.getElementById("recoveryChainId"),
  recoveryTxHash: document.getElementById("recoveryTxHash"),
  recoveryIssue: document.getElementById("recoveryIssue"),
  submitRecoveryBtn: document.getElementById("submitRecoveryBtn"),
  recoveryStatus: document.getElementById("recoveryStatus"),
  walletAvailabilityBadge: document.getElementById("walletAvailabilityBadge"),
  walletSupportCard: document.getElementById("walletSupportCard"),
  walletSupportTitle: document.getElementById("walletSupportTitle"),
  supportedWalletChips: document.getElementById("supportedWalletChips"),
  walletSupportText: document.getElementById("walletSupportText"),
  walletHelpLink: document.getElementById("walletHelpLink"),
  walletPayBtn: document.getElementById("walletPayBtn"),
  paymentGateHint: document.getElementById("paymentGateHint"),
  goToConsentBtn: document.getElementById("goToConsentBtn"),
  secondaryPaymentActions: document.getElementById("secondaryPaymentActions"),
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
  paymentConditionsList: document.getElementById("paymentConditionsList"),
  paymentVerifyCard: document.getElementById("paymentVerifyCard"),
  verifyNetworkText: document.getElementById("verifyNetworkText"),
  verifyTokenText: document.getElementById("verifyTokenText"),
  tokenContractText: document.getElementById("tokenContractText"),
  copyTokenContractBtn: document.getElementById("copyTokenContractBtn"),
  verifyAddressText: document.getElementById("verifyAddressText"),
  manualRiskText: document.getElementById("manualRiskText"),
  toggleAddressBtn: document.getElementById("toggleAddressBtn"),
  receiptCard: document.getElementById("receiptCard"),
  receiptTitle: document.getElementById("receiptTitle"),
  receiptStatusBadge: document.getElementById("receiptStatusBadge"),
  receiptStoreName: document.getElementById("receiptStoreName"),
  receiptAmount: document.getElementById("receiptAmount"),
  receiptInvoiceId: document.getElementById("receiptInvoiceId"),
  receiptTxHash: document.getElementById("receiptTxHash"),
  receiptChainRecordedAt: document.getElementById("receiptChainRecordedAt"),
  receiptConfirmedAt: document.getElementById("receiptConfirmedAt"),
  receiptEvidenceNotice: document.getElementById("receiptEvidenceNotice"),
  copyReceiptBtn: document.getElementById("copyReceiptBtn"),
  consentGateSection: document.getElementById("consentGateSection"),
  consentCheckbox: document.getElementById("consentCheckbox"),
  consentLiveStatus: document.getElementById("consentLiveStatus"),
  consentRecordError: document.getElementById("consentRecordError"),
  retryConsentBtn: document.getElementById("retryConsentBtn"),
  consentTermsLink: document.getElementById("consentTermsLink"),
  consentPrivacyLink: document.getElementById("consentPrivacyLink"),
  consentRefundLink: document.getElementById("consentRefundLink"),
  technicalDetails: document.getElementById("technicalDetails"),
};

const CUSTOMER_ERROR_CATALOG = Object.freeze({
  INVOICE_REFRESH_FAILED: {
    message: "請求の最新状態を確認できません。追加送金せず、再取得してください。",
    action: "支払い操作を止めて再取得する",
    supportCode: "CUST-INVOICE-REFRESH",
  },
  CONSENT_RECORD_FAILED: {
    message: "同意の記録を確認できません。再送が成功するまで支払い操作はできません。",
    action: "内容を確認して再送する",
    supportCode: "CUST-CONSENT",
  },
  CONSENT_RECORD_TIMEOUT: {
    message: "同意の記録が時間内に完了しませんでした。再送が成功するまで支払い操作はできません。",
    action: "通信状態を確認して再送する",
    supportCode: "CUST-CONSENT-TIMEOUT",
  },
  WALLET_LAUNCH_FAILED: {
    message: "ウォレットを開けません。支払い情報を確認して手動送金案内を利用してください。",
    action: "ウォレットまたは手動送金案内を確認する",
    supportCode: "CUST-WALLET",
  },
  COPY_FAILED: {
    message: "コピーできませんでした。画面の支払い情報を確認してください。",
    action: "再試行する",
    supportCode: "CUST-COPY",
  },
  INVOICE_NOT_PAYABLE: {
    message: "この請求では現在支払い操作を受け付けていません。",
    action: "店舗スタッフへ確認する",
    supportCode: "CUST-NOT-PAYABLE",
  },
  PAYMENT_DETECTED: {
    message: "送金を受け付けました。追加送金せず、確認が完了するまでお待ちください。",
    action: "そのまま待つ",
    supportCode: "CUST-PAYMENT-DETECTED",
  },
  INTEGRITY_HOLD: {
    message: "支払い記録を確認しています。追加送金せず、店舗スタッフへお声がけください。",
    action: "店舗スタッフへ確認する",
    supportCode: "CUST-INTEGRITY-HOLD",
  },
  PAYMENT_RECOVERY_UNAVAILABLE: {
    message: "確認依頼に利用できるチェーン情報を確認できません。追加送金せず、店舗スタッフへお声がけください。",
    action: "店舗スタッフへ確認する",
    supportCode: "CUST-RECOVERY-CHAIN",
  },
  PAYMENT_RECOVERY_TIMEOUT: {
    message: "確認依頼の送信が時間内に完了しませんでした。追加送金せず、通信状態を確認して再試行してください。",
    action: "通信状態を確認して再試行する",
    supportCode: "CUST-RECOVERY-TIMEOUT",
  },
  UNSUPPORTED_PAYMENT_CHAIN: {
    message: "選択したチェーンは現在の確認依頼では利用できません。追加送金せず、店舗スタッフへお声がけください。",
    action: "店舗スタッフへ確認する",
    supportCode: "CUST-RECOVERY-UNSUPPORTED",
  },
});

function customerFacingError(error, fallbackCode = "INVOICE_REFRESH_FAILED") {
  const code = String(error?.customerCode || error?.code || fallbackCode).toUpperCase();
  const entry = CUSTOMER_ERROR_CATALOG[code] || CUSTOMER_ERROR_CATALOG[fallbackCode] || CUSTOMER_ERROR_CATALOG.INVOICE_REFRESH_FAILED;
  return `${entry.message}（問い合わせコード: ${entry.supportCode}）`;
}

function customerErrorFromResponse(payload, fallbackCode) {
  const error = new Error(fallbackCode);
  error.customerCode = String(payload?.error?.code || fallbackCode).toUpperCase();
  return error;
}

function announce(message) {
  const next = message || "";
  if (el.liveStatus.textContent !== next) el.liveStatus.textContent = next;
}

function renderErrorBanner() {
  const retryInProgress = Boolean(
    state.invoice === null
    && state.automaticRetryTimer
    && state.automaticRetryCount <= INITIAL_RETRY_DELAYS_MS.length
  );
  const baseMessage = state.blockingWarning || state.transientError;
  const message = baseMessage && retryInProgress
    ? `${baseMessage} 自動再試行中です（${state.automaticRetryCount}/${INITIAL_RETRY_DELAYS_MS.length}）。`
    : baseMessage;
  if (!message) {
    el.errorBanner.classList.add("hidden");
    el.errorBannerText.textContent = "";
    el.retryLoadBtn?.classList.add("hidden");
    el.closeErrorBannerBtn.classList.remove("hidden");
    return;
  }
  el.errorBanner.classList.remove("hidden");
  if (el.errorBannerText.textContent !== message) el.errorBannerText.textContent = message;
  if (el.retryLoadBtn) {
    const retryAvailable = Boolean(
      state.blockingWarning
      && signedInvoicePath()
      && state.invoice === null
      && !state.automaticRetryTimer
      && state.automaticRetryCount >= INITIAL_RETRY_DELAYS_MS.length
    );
    el.retryLoadBtn.classList.toggle("hidden", !retryAvailable);
    el.retryLoadBtn.disabled = state.refreshInProgress;
  }
  el.closeErrorBannerBtn.classList.toggle("hidden", Boolean(state.blockingWarning));
}

function showError(message) {
  state.transientError = String(message || "");
  renderErrorBanner();
}

function setBlockingWarning(message) {
  state.blockingWarning = String(message || "");
  renderErrorBanner();
}

function clearAutomaticRetry() {
  if (state.automaticRetryTimer) clearTimeout(state.automaticRetryTimer);
  state.automaticRetryTimer = null;
}

function scheduleAutomaticRetry() {
  clearAutomaticRetry();
  if (!signedInvoicePath() || state.automaticRetryCount >= INITIAL_RETRY_DELAYS_MS.length) {
    renderErrorBanner();
    if (state.invoice === null && state.blockingWarning) announce("自動再試行に失敗しました。「請求を再取得」を押してください");
    return;
  }
  const delayMs = INITIAL_RETRY_DELAYS_MS[state.automaticRetryCount];
  state.automaticRetryCount += 1;
  state.automaticRetryTimer = window.setTimeout(() => {
    state.automaticRetryTimer = null;
    void loadInvoice({ silent: true, force: true });
  }, delayMs);
  renderErrorBanner();
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

function getOfficialTokenContract(invoice) {
  return String(invoice?.official_token_contract || "").trim();
}

function getNetwork(invoice) {
  return String(invoice?.network || (invoice?.chain_id === "137" ? "Polygon" : invoice?.chain_id || "-"));
}

function getNativeSymbol(invoice) {
  const configured = String(invoice?.native_symbol || "").trim();
  if (configured) return configured;
  return ({ "1": "ETH", "43114": "AVAX", "137": "POL" })[String(invoice?.chain_id || "")] || "ネットワーク通貨";
}

function getReceiveAddress(invoice) {
  return String(invoice?.receive_address || invoice?.recipient_address || "");
}

function getCopyFallback(invoice) {
  return invoice?.copy_fallback || {};
}

function safeTimeZone(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "UTC";
  try {
    new Intl.DateTimeFormat("ja-JP", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_error) {
    return "UTC";
  }
}

function formatDateTime(value) {
  if (!value) return "-";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  const timeZone = safeTimeZone(state.storeTimezone);
  return `${dt.toLocaleString("ja-JP", { timeZone, hour12: false })}（${timeZone}）`;
}

function renderChipGroup(host, values, fallback = "案内準備中") {
  const items = Array.isArray(values) && values.length > 0 ? values : [fallback];
  const nextValues = items.map((value) => String(value || fallback));
  const currentValues = Array.from(host.children).map((node) => node.textContent || "");
  if (JSON.stringify(currentValues) === JSON.stringify(nextValues)) return;
  host.innerHTML = "";
  for (const value of nextValues) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = value;
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

function setHelperLink(linkEl, href, label) {
  const raw = typeof href === "string" ? href.trim() : "";
  let safeHref = "";
  if (raw) {
    try {
      const parsed = new URL(raw, window.location.origin);
      if (!parsed.username && !parsed.password && (parsed.protocol === "https:" || parsed.origin === window.location.origin)) {
        safeHref = parsed.href;
      }
    } catch {
      safeHref = "";
    }
  }
  if (safeHref) {
    linkEl.href = safeHref;
    linkEl.textContent = label;
    linkEl.classList.remove("hidden");
    return;
  }
  linkEl.classList.add("hidden");
  linkEl.removeAttribute("href");
}

function middleEllipsis(value, head = 10, tail = 8) {
  const text = String(value || "");
  if (!text || text.length <= head + tail + 1) return text || "-";
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function serverAwareNowMs() {
  if (!Number.isFinite(state.serverClockOffsetMs)) return null;
  return Date.now() + state.serverClockOffsetMs;
}

function updateServerClock(response, requestStartedAtMs, serverNowValue) {
  const payloadServerNowMs = serverNowValue ? new Date(serverNowValue).getTime() : NaN;
  const serverDate = response?.headers?.get?.("date");
  const headerServerNowMs = serverDate ? new Date(serverDate).getTime() : NaN;
  const serverNowMs = Number.isFinite(payloadServerNowMs) ? payloadServerNowMs : headerServerNowMs;
  if (!Number.isFinite(serverNowMs)) {
    state.serverClockOffsetMs = null;
    return;
  }
  const safeLocalReferenceMs = Number.isFinite(requestStartedAtMs) ? requestStartedAtMs : Date.now();
  state.serverClockOffsetMs = serverNowMs - safeLocalReferenceMs;
}

function remainingSeconds(expiresAt) {
  const nowMs = serverAwareNowMs();
  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs)) return null;
  return Math.floor((expiryMs - nowMs) / 1000);
}

function isPublicPolicyHostname(value) {
  const host = String(value || "").trim().toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (!host || !host.includes(".")) return false;
  if (host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".test")
    || host.endsWith(".invalid")
    || host.endsWith(".example")
    || host.endsWith(".arpa")
  ) return false;
  return ![
    "example.com",
    "example.org",
    "example.net",
  ].some((reservedHost) => host === reservedHost || host.endsWith(`.${reservedHost}`));
}

function isPublishedPolicyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && isPublicPolicyHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function policyLinksReady() {
  const urlsReady = Object.values(POLICY_URLS).every(isPublishedPolicyUrl);
  const versionsReady = Object.values(POLICY_VERSIONS).every((value) => {
    const version = String(value || "").trim();
    return Boolean(version) && !/(?:draft|pending|placeholder|example)/i.test(version);
  });
  return urlsReady && versionsReady;
}

function formatRemaining(expiresAt) {
  if (!expiresAt) return "期限情報を確認中です。";
  const totalSec = remainingSeconds(expiresAt);
  if (totalSec == null) return "期限情報を再確認中です。";
  if (totalSec <= 0) return "期限切れです。";
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `残り ${String(mins)}分${String(secs).padStart(2, "0")}秒`;
}

function shouldPoll(status) {
  return !FINAL_STATUSES.has(canonicalInvoiceStatus(status));
}

function canonicalInvoiceStatus(status) {
  const raw = String(status || "").trim();
  if (!raw) return "";
  return INVOICE_STATUS_ALIASES[raw] || raw;
}

function hasFreshInvoiceObservation(invoice = state.invoice) {
  return state.lastRefreshSucceeded
    && String(state.lastRefreshInvoiceId || "") === String(invoice?.invoice_id || "")
    && Number.isFinite(state.lastRefreshAtMs)
    && state.lastRefreshAtMs > 0
    && Date.now() - state.lastRefreshAtMs <= OBSERVATION_FRESHNESS_MS;
}

function hasIntegrityHold(invoice) {
  if (!invoice) return false;
  const explicitHold = invoice.integrity_hold === true
    || invoice.integrity_hold === 1
    || ["active", "hold", "integrity_hold"].includes(String(invoice.integrity_hold || "").toLowerCase());
  const statusReason = String(invoice.integrity_hold_reason || invoice.status_reason || "").toLowerCase();
  return explicitHold || ["integrity_hold", "chain_reorg_detected", "reorg_detected", "chain_reorg"].includes(statusReason);
}

function validatePaymentDetails(invoice) {
  const chainId = String(invoice?.chain_id || "").trim();
  const tokenContract = String(invoice?.token_contract || "").trim();
  const officialTokenContract = getOfficialTokenContract(invoice);
  const receiveAddress = String(invoice?.receive_address || "").trim();
  const recipientAddress = String(invoice?.recipient_address || "").trim();
  const amountJpyc = Number(invoice?.amount_jpyc);
  const amountJpycBase = String(invoice?.amount_jpyc_base ?? "").trim();
  const expectedAmountAtomic = String(invoice?.expected_amount_atomic ?? "").trim();
  const tokenDecimalsRaw = invoice?.token_decimals;
  const tokenDecimals = Number(tokenDecimalsRaw);
  const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;

  if (!/^\d+$/.test(chainId) || BigInt(chainId) <= 0n) return { ok: false, reason: "chain_id" };
  if (!evmAddressPattern.test(tokenContract)) return { ok: false, reason: "token_contract" };
  if (!evmAddressPattern.test(officialTokenContract)
    || officialTokenContract.toLowerCase() !== tokenContract.toLowerCase()) {
    return { ok: false, reason: "official_token_contract" };
  }
  if (!evmAddressPattern.test(receiveAddress)) return { ok: false, reason: "receive_address" };
  if (!recipientAddress || recipientAddress.toLowerCase() !== receiveAddress.toLowerCase()) {
    return { ok: false, reason: "recipient_mismatch" };
  }
  if (!Number.isFinite(amountJpyc) || amountJpyc <= 0) return { ok: false, reason: "amount_jpyc" };
  if (!/^[1-9]\d*$/.test(amountJpycBase)) return { ok: false, reason: "amount_jpyc_base" };
  if (!/^[1-9]\d*$/.test(expectedAmountAtomic)) return { ok: false, reason: "expected_amount_atomic" };
  if (tokenDecimalsRaw == null || String(tokenDecimalsRaw).trim() === ""
    || !Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255) {
    return { ok: false, reason: "token_decimals" };
  }

  const copyFallback = invoice?.copy_fallback;
  if (!copyFallback
    || String(copyFallback.copy_receive_address || "").toLowerCase() !== receiveAddress.toLowerCase()
    || String(copyFallback.copy_amount || "") !== expectedAmountAtomic) {
    return { ok: false, reason: "copy_fallback" };
  }

  try {
    const paymentUri = new URL(String(invoice?.payment_uri || ""));
    const match = paymentUri.pathname.match(/^([^@]+)@(\d+)\/transfer$/);
    const keys = [...paymentUri.searchParams.keys()].sort();
    const uriToken = String(match?.[1] || "");
    const uriChainId = String(match?.[2] || "");
    const uriAddress = String(paymentUri.searchParams.get("address") || "");
    const uriAmount = String(paymentUri.searchParams.get("uint256") || "");
    const exactKeys = keys.length === 2 && keys[0] === "address" && keys[1] === "uint256";
    if (
      paymentUri.protocol !== "ethereum:"
      || !match
      || !exactKeys
      || paymentUri.searchParams.getAll("address").length !== 1
      || paymentUri.searchParams.getAll("uint256").length !== 1
      || uriToken.toLowerCase() !== tokenContract.toLowerCase()
      || uriChainId !== chainId
      || uriAddress.toLowerCase() !== receiveAddress.toLowerCase()
      || uriAmount !== expectedAmountAtomic
    ) return { ok: false, reason: "payment_uri" };
  } catch {
    return { ok: false, reason: "payment_uri" };
  }

  return { ok: true, reason: "" };
}

function evaluatePaymentActionGate(invoice = state.invoice) {
  if (!invoice) {
    if (state.blockingWarning) {
      return {
        allowed: false,
        code: "load_failed",
        message: "請求を再取得してください。",
        blockingMessage: state.blockingWarning,
      };
    }
    return { allowed: false, code: "loading", message: "最新の請求状態を確認しています。", blockingMessage: "" };
  }

  const status = canonicalInvoiceStatus(invoice.status);
  const customerMode = invoice?.customer_payment_mode || {};
  if (state.refreshInProgress) {
    return {
      allowed: false,
      code: "refresh_in_progress",
      message: "最新の請求状態を再確認しています。",
      blockingMessage: "再取得が完了するまで、送金・手動送金・コピー操作を停止しています。",
    };
  }
  if (hasIntegrityHold(invoice)) {
    return {
      allowed: false,
      code: "integrity_hold",
      message: "記録整合性を確認中です。追加送金は行わないでください。",
      blockingMessage: "チェーン再編成または支払い記録の整合性確認中です。送金・手動送金・コピー操作を停止しています。店舗スタッフへお声がけください。",
    };
  }
  const refreshMatchesInvoice = hasFreshInvoiceObservation(invoice);
  if (!refreshMatchesInvoice) {
    return {
      allowed: false,
      code: "refresh_required",
      message: "最新状態を取得できるまで支払い操作を停止しています。",
      blockingMessage: "請求の最新状態を確認できないため、送金・手動送金・コピー操作を停止しています。再取得してください。",
    };
  }
  if (!STATUS_COPY[status]) {
    return {
      allowed: false,
      code: "unknown_status",
      message: "請求状態を判定できないため支払えません。",
      blockingMessage: "不明な請求状態です。送金せず、最新の状態を再取得してください。",
    };
  }
  if (!PAYMENT_ACTION_STATUSES.has(status)) {
    const message = ["payment_detected", "confirming"].includes(status)
      ? "送金確認中です。二重送金せず、このままお待ちください。"
      : "現在の状態では支払い操作は必要ありません。";
    return { allowed: false, code: "status_not_payable", message, blockingMessage: "" };
  }
  if (customerMode.mode !== "wallet_qr") {
    return {
      allowed: false,
      code: customerMode.mode ? "store_guidance" : "payment_mode_unknown",
      message: customerMode.body || "支払い方式を確認できないため、店頭スタッフにご確認ください。",
      blockingMessage: customerMode.mode ? "" : "支払い方式が不明なため、送金・手動送金・コピー操作を停止しています。",
    };
  }
  const paymentDetails = validatePaymentDetails(invoice);
  if (!paymentDetails.ok) {
    return {
      allowed: false,
      code: "payment_details_invalid",
      message: "支払い先・金額・ネットワーク情報の整合性を確認できません。",
      blockingMessage: "支払い情報が不完全または不整合なため、送金・手動送金・コピー操作を停止しています。店舗スタッフにお声がけください。",
    };
  }
  const remaining = remainingSeconds(invoice.expires_at);
  if (remaining == null) {
    return {
      allowed: false,
      code: "expiry_unknown",
      message: "サーバー時刻と支払い期限を確認できるまで支払えません。",
      blockingMessage: "支払い期限を安全に判定できません。送金せず、最新の状態を再取得してください。",
    };
  }
  if (remaining <= 0) {
    return {
      allowed: false,
      code: "expired",
      message: "この請求は期限切れです。新しい請求を店舗スタッフに依頼してください。",
      blockingMessage: "この請求は期限切れです。送金・手動送金・コピーは行わないでください。",
    };
  }
  if (!policyLinksReady()) {
    return {
      allowed: false,
      code: "policy_unavailable",
      message: "利用規約・プライバシーポリシー・返金ポリシーの公開URLと承認版を確認できません。",
      blockingMessage: "規約3点の公開URLまたは承認版を確認できないため、支払い操作を停止しています。店舗スタッフへお声がけください。",
    };
  }
  if (!state.consented) {
    return {
      allowed: false,
      code: "consent_required",
      message: "利用規約・ポリシーを確認し、同意にチェックすると支払えます。",
      blockingMessage: "",
    };
  }
  if (state.consentRecordStatus !== "recorded") {
    return {
      allowed: false,
      code: "consent_record_required",
      message: "同意記録がサーバーへ保存されるまで支払い操作を停止しています。",
      blockingMessage: state.consentRecordStatus === "failed"
        ? "同意記録を保存できませんでした。再送が成功するまで支払い操作はできません。"
        : "同意記録を保存しています。完了するまで支払い操作はできません。",
    };
  }
  if (state.launchInProgress) {
    return { allowed: false, code: "launch_in_progress", message: "ウォレットを開いています。連続で押さないでください。", blockingMessage: "" };
  }
  return { allowed: true, code: "ready", message: "最新状態と支払い期限を確認済みです。", blockingMessage: "" };
}

function applyPaymentActionGate(invoice = state.invoice) {
  const gate = evaluatePaymentActionGate(invoice);
  const walletAllowed = gate.allowed && state.consented;
  for (const control of [el.walletPayBtn, el.showMethodsBtn, el.copyInfoBtn]) {
    if (control) control.disabled = !walletAllowed;
  }
  el.copyAddressBtn.disabled = !walletAllowed;
  el.copyAmountBtn.disabled = !walletAllowed;
  el.copyInvoiceBtn.disabled = !walletAllowed;
  el.copyTokenContractBtn.disabled = !walletAllowed;
  if (el.paymentGateHint && el.paymentGateHint.textContent !== gate.message) {
    el.paymentGateHint.textContent = gate.message;
  }
  if (el.goToConsentBtn) {
    el.goToConsentBtn.classList.toggle("hidden", gate.code !== "consent_required");
  }
  setPaymentSurfacesBlocked(Boolean(gate.blockingMessage));
  if (!gate.allowed && gate.code !== "launch_in_progress") setMethodPanel(false, "");
  setBlockingWarning(gate.blockingMessage);
  if (gate.blockingMessage) applyBlockingCustomerCopy(gate);
  return gate;
}

function setPaymentSurfacesBlocked(blocked) {
  for (const surface of [
    el.secondaryPaymentActions,
    el.paymentRecoveryDetails,
    el.walletSupportCard,
    el.paymentConditionsCard,
    el.paymentVerifyCard,
    el.technicalDetails,
    el.consentGateSection,
  ]) {
    surface?.classList.toggle("payment-surface-blocked", Boolean(blocked));
  }
}

function setCustomerActionBadge(label, tone = "s-gray") {
  if (!el.customerActionBadge) return;
  el.customerActionBadge.textContent = label;
  el.customerActionBadge.className = `status-pill ${tone}`;
}

function applyBlockingCustomerCopy(gate) {
  if (!gate?.blockingMessage || !el.customerActionBadge) return;
  el.statusPill.textContent = "支払い停止";
  el.statusPill.className = "status-pill s-red";
  el.uxStateLabel.textContent = "現在は支払いできません";
  el.uxStateDetail.textContent = gate.blockingMessage;
  setCustomerActionBadge("支払い停止", "s-red");
  el.customerActionTitle.textContent = "支払い操作を停止しています";
  el.customerActionBody.textContent = gate.blockingMessage;
  el.customerActionList.replaceChildren();
  for (const item of [
    "追加送金や再送信は行わないでください。",
    gate.code === "policy_unavailable" ? "公開済みポリシーを確認できるまで支払えません。" : "「請求を再取得」を押して最新状態を確認してください。",
    "解決しない場合は、この画面を店舗スタッフへ見せてください。",
  ]) {
    const li = document.createElement("li");
    li.textContent = item;
    el.customerActionList.appendChild(li);
  }
  state.manualActionHint = gate.blockingMessage;
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

function stopObservationFreshnessTimer() {
  if (!state.observationFreshnessTimer) return;
  clearTimeout(state.observationFreshnessTimer);
  state.observationFreshnessTimer = null;
}

function renderInvoiceObservationState() {
  if (!state.invoice) return;
  renderCustomerAction(state.invoice);
  renderPaymentRecovery(state.invoice);
  renderReceiptCard(state.invoice);
  renderStatus(state.invoice);
  applyPaymentActionGate(state.invoice);
}

function failClosedInvoiceObservation() {
  state.lastRefreshSucceeded = false;
  state.lastRefreshInvoiceId = "";
  state.lastRefreshAtMs = 0;
  stopObservationFreshnessTimer();
  renderInvoiceObservationState();
}

function scheduleObservationFreshnessHold() {
  stopObservationFreshnessTimer();
  if (!state.invoice || !hasFreshInvoiceObservation(state.invoice)) return;
  const delayMs = Math.max(state.lastRefreshAtMs + OBSERVATION_FRESHNESS_MS - Date.now() + 1, 1);
  state.observationFreshnessTimer = setTimeout(() => {
    state.observationFreshnessTimer = null;
    state.lastRefreshSucceeded = false;
    renderInvoiceObservationState();
  }, delayMs);
}

function startRemainingTimer(invoice) {
  stopRemainingTimer();
  if (!invoice?.expires_at || !WAITING_STATUSES.has(canonicalInvoiceStatus(invoice?.status))) return;
  state.remainingTimer = setInterval(() => {
    updateRemainingAnnouncement(invoice.expires_at);
    const gate = applyPaymentActionGate(invoice);
    if (gate.code === "expired") {
      el.remainingText.classList.add("attention-pulse");
    } else {
      el.remainingText.classList.remove("attention-pulse");
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

function signedPayPath() {
  if (!invoiceId || !sig || !exp || !nonce) return null;
  return `/api/v1/public/invoices/${encodeURIComponent(invoiceId)}/pay?sig=${encodeURIComponent(sig)}&exp=${encodeURIComponent(exp)}&nonce=${encodeURIComponent(nonce)}`;
}

function signedConsentPath() {
  if (!invoiceId || !sig || !exp || !nonce) return null;
  return `/api/v1/public/invoices/${encodeURIComponent(invoiceId)}/consent?sig=${encodeURIComponent(sig)}&exp=${encodeURIComponent(exp)}&nonce=${encodeURIComponent(nonce)}`;
}

function signedRecoveryPath() {
  if (!invoiceId || !sig || !exp || !nonce) return null;
  return `/api/v1/public/invoices/${encodeURIComponent(invoiceId)}/payment-recovery?sig=${encodeURIComponent(sig)}&exp=${encodeURIComponent(exp)}&nonce=${encodeURIComponent(nonce)}`;
}

function initPolicyLinks() {
  for (const [link, url] of [
    [el.consentTermsLink, POLICY_URLS.terms],
    [el.consentPrivacyLink, POLICY_URLS.privacy],
    [el.consentRefundLink, POLICY_URLS.refund],
  ]) {
    if (!link) continue;
    const ready = isPublishedPolicyUrl(url);
    link.classList.toggle("hidden", !ready);
    if (ready) link.href = String(url).trim();
    else link.removeAttribute("href");
  }
}

async function recordConsent() {
  const path = signedConsentPath();
  if (state.consentRecordStatus === "pending") return false;
  if (!state.consented || !el.consentCheckbox?.checked) {
    state.consentRecordStatus = "failed";
    state.consentRecordError = "同意チェックが外れています。内容を確認し、再度チェックを入れてください。";
    renderConsentRecordState();
    applyPaymentActionGate(state.invoice);
    return false;
  }
  if (!policyLinksReady()) {
    state.consentRecordStatus = "failed";
    state.consentRecordError = "規約3点の公開URLまたは承認版を確認できないため、同意を記録できません。";
    renderConsentRecordState();
    applyPaymentActionGate(state.invoice);
    return false;
  }
  if (!path) {
    state.consentRecordStatus = "failed";
    state.consentRecordError = "同意記録の送信先を確認できません。支払いURLを再確認してください。";
    renderConsentRecordState();
    applyPaymentActionGate(state.invoice);
    return false;
  }
  state.consentRecordStatus = "pending";
  state.consentRecordError = "";
  const consentSequence = state.consentSequence + 1;
  state.consentSequence = consentSequence;
  if (state.consentController) state.consentController.abort();
  const controller = new AbortController();
  state.consentController = controller;
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MOBILE_REQUEST_TIMEOUT_MS);
  renderConsentRecordState();
  applyPaymentActionGate(state.invoice);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(POLICY_VERSIONS),
      signal: controller.signal,
    });
    if (consentSequence !== state.consentSequence || !state.consented || !el.consentCheckbox?.checked) {
      return false;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw customerErrorFromResponse(payload, "CONSENT_RECORD_FAILED");
    }
    state.consentRecordStatus = "recorded";
    state.consentRecordError = "";
    state.lastRefreshSucceeded = false;
    state.lastRefreshInvoiceId = "";
    renderConsentRecordState();
    applyPaymentActionGate(state.invoice);
    const refreshResult = await loadInvoice({ silent: true, force: true });
    return refreshResult?.ok === true;
  } catch (error) {
    if (consentSequence !== state.consentSequence || (error?.name === "AbortError" && !timedOut)) return false;
    const effectiveError = error?.name === "AbortError" && timedOut
      ? Object.assign(new Error("CONSENT_RECORD_TIMEOUT"), { customerCode: "CONSENT_RECORD_TIMEOUT" })
      : error;
    state.consentRecordStatus = "failed";
    state.consentRecordError = customerFacingError(effectiveError, "CONSENT_RECORD_FAILED");
    renderConsentRecordState();
    applyPaymentActionGate(state.invoice);
    return false;
  } finally {
    clearTimeout(timeoutId);
    if (consentSequence === state.consentSequence) state.consentController = null;
  }
}

function renderConsentRecordState() {
  if (!el.consentRecordError || !el.retryConsentBtn) return;
  const failed = state.consentRecordStatus === "failed";
  el.consentRecordError.classList.toggle("hidden", !failed);
  if (failed && el.consentRecordError.textContent !== state.consentRecordError) {
    el.consentRecordError.textContent = state.consentRecordError;
  }
  if (!failed) el.consentRecordError.textContent = "";
  el.retryConsentBtn.classList.toggle("hidden", !failed);
  el.retryConsentBtn.disabled = state.consentRecordStatus === "pending" || !state.consented || !el.consentCheckbox?.checked;
}

function renderConsentGate(invoice) {
  const needsConsent = PAYMENT_ACTION_STATUSES.has(canonicalInvoiceStatus(invoice?.status));
  if (!el.consentGateSection) return;
  el.consentGateSection.classList.toggle("hidden", !needsConsent);
  if (!needsConsent) return;
  const policiesReady = policyLinksReady();
  if (el.consentCheckbox) {
    el.consentCheckbox.disabled = !policiesReady;
    el.consentCheckbox.checked = policiesReady && state.consented;
  }
  if (el.consentLiveStatus) {
    const message = !policiesReady
      ? "規約3点の公開URLまたは承認版を確認できないため、支払い操作を停止しています。"
      : state.consentRecordStatus === "recorded"
        ? "同意記録を保存しました。お支払い操作が可能です。"
        : state.consented
          ? "同意記録をサーバーへ保存しています。"
          : "利用規約・ポリシーをご確認のうえ、チェックを入れてください。";
    if (el.consentLiveStatus.textContent !== message) el.consentLiveStatus.textContent = message;
  }
  renderConsentRecordState();
}

function focusConsentGate() {
  if (!el.consentGateSection || !el.consentCheckbox) return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  el.consentGateSection.classList.add("attention-pulse");
  el.consentGateSection.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  window.setTimeout(() => {
    el.consentCheckbox.focus({ preventScroll: true });
    el.consentGateSection.classList.remove("attention-pulse");
  }, reduceMotion ? 0 : 300);
}

function buildWalletLaunchCandidates(invoice) {
  if (!invoice) return [];
  const adapter = invoice.wallet_adapter || {};
  if (adapter.available !== true || adapter.status !== "ready") return [];
  const candidates = [
    { type: "wallet_deeplink", url: invoice.wallet_deeplink },
    { type: "payment_uri", url: invoice.payment_uri },
    { type: "wallet_url", url: invoice.wallet_url },
  ];
  const validCandidates = [];
  const seenUrls = new Set();
  for (const candidate of candidates) {
    if (typeof candidate.url !== "string" || !candidate.url.trim()) continue;
    const raw = candidate.url.trim();
    if (seenUrls.has(raw)) continue;
    try {
      const parsed = new URL(raw);
      if (WALLET_LAUNCH_PROTOCOLS.has(parsed.protocol) && !parsed.username && !parsed.password) {
        validCandidates.push({ type: candidate.type, url: raw });
        seenUrls.add(raw);
      }
    } catch {
      // Unsafe or malformed targets fall through to the copy guidance.
    }
  }
  return validCandidates;
}

function buildWalletLaunchTarget(invoice) {
  return buildWalletLaunchCandidates(invoice)[0] || null;
}

function buildManualPaymentInstructions(invoice, options = {}) {
  const { includeHelp = false } = options;
  const fallback = getCopyFallback(invoice);
  const lines = [
    "ウォレットが自動起動しない場合は、以下の内容を手動で入力して送金してください。",
    `ネットワーク: ${fallback.copy_network || getNetwork(invoice) || "-"}`,
    `トークン: ${fallback.copy_token || getTokenSymbol(invoice) || "JPYC"}`,
    `公式JPYCコントラクト: ${getOfficialTokenContract(invoice) || "-"}`,
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
  if (hasIntegrityHold(invoice)) {
    return "支払い記録の整合性確認中です。追加送金は行わず、店舗スタッフへお声がけください。";
  }
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
    return "ウォレット連携は現在利用できません。「支払い情報をコピー」または手動送金案内をご利用ください。";
  }
  return "支払い情報をコピーするか、手動送金案内を確認して送金してください。";
}

function manualRiskMessage(invoice) {
  return "ウォレット自動起動が利用できません。手動送金では、ウォレット画面のネットワーク・トークン・送金先・金額をこの画面と必ず目視照合してください。";
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

function renderWalletSupport(invoice) {
  const customerMode = invoice?.customer_payment_mode || {};
  if (customerMode.mode && customerMode.mode !== "wallet_qr") {
    renderChipGroup(el.supportedWalletChips, ["店頭端末でご案内"], "店頭端末でご案内");
    el.walletAvailabilityBadge.textContent = "店頭案内";
    el.walletSupportText.textContent = customerMode.body || "この会計は店頭端末でご案内します。";
    el.walletHelpLink.classList.add("hidden");
    el.walletHelpLink.removeAttribute("href");
    return;
  }
  const launchTarget = buildWalletLaunchTarget(invoice);
  const adapter = invoice?.wallet_adapter || {};
  const supportedWallets = Array.isArray(invoice?.supported_wallets) ? invoice.supported_wallets : [];
  const capabilityLabels = normalizeWalletCapabilityLabels(supportedWallets, { manualOnly: !launchTarget });
  if (el.walletSupportTitle) el.walletSupportTitle.textContent = "ウォレット起動状況";
  renderChipGroup(el.supportedWalletChips, capabilityLabels, "未検証: ウォレット情報なし");

  if (launchTarget) {
    el.walletAvailabilityBadge.textContent = "起動導線あり";
    el.walletSupportText.textContent = "表示したOS・ウォレット版は検証記録の範囲であり、この端末の動作保証ではありません。起動しない場合は支払い情報コピーか手動送金案内をご利用ください。";
  } else if (adapter.reason) {
    el.walletAvailabilityBadge.textContent = "手動案内";
    el.walletSupportText.textContent = "自動起動が使えないため、手動送金をご案内します。";
  } else {
    el.walletAvailabilityBadge.textContent = "コピー送金";
    el.walletSupportText.textContent = "支払い情報をコピーして、お使いのウォレットから送金してください。";
  }

  setHelperLink(el.walletHelpLink, invoice?.wallet_help_url || "", "ウォレット案内を開く");
}

function normalizeRecoveryChains(invoice) {
  const source = Array.isArray(invoice?.payment_recovery_chains)
    ? invoice.payment_recovery_chains
    : [];
  const seen = new Set();
  const normalized = [];
  for (const chain of source) {
    const chainId = String(chain?.chain_id || "").trim();
    if (!/^\d+$/.test(chainId) || seen.has(chainId)) continue;
    seen.add(chainId);
    const network = String(chain?.network || chain?.name || "").trim();
    normalized.push({
      chainId,
      label: network ? `${network}（チェーンID: ${chainId}）` : `チェーンID: ${chainId}`,
    });
  }
  return normalized;
}

function syncRecoveryChainOptions(invoice) {
  if (!el.recoveryChainId) return;
  const previousValue = String(el.recoveryChainId.value || "");
  state.recoveryChains = normalizeRecoveryChains(invoice);
  el.recoveryChainId.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.recoveryChains.length > 0
    ? "送金したチェーンを選択"
    : "利用可能なチェーンを確認できません";
  el.recoveryChainId.appendChild(placeholder);
  for (const chain of state.recoveryChains) {
    const option = document.createElement("option");
    option.value = chain.chainId;
    option.textContent = chain.label;
    el.recoveryChainId.appendChild(option);
  }
  const previousStillAllowed = state.recoveryChains.some((chain) => chain.chainId === previousValue);
  el.recoveryChainId.value = previousStillAllowed ? previousValue : "";
  el.recoveryChainId.disabled = state.recoveryChains.length === 0 || state.recoverySubmitting;
}

function renderPaymentRecovery(invoice) {
  if (!el.paymentRecoveryDetails) return;
  syncRecoveryChainOptions(invoice);
  const report = invoice?.payment_recovery || null;
  const status = String(report?.status || "");
  const labels = {
    verified_wrong_chain: "誤チェーンを確認済み",
    verified_wrong_token: "誤トークンを確認済み",
    customer_reported_wrong_chain: "誤チェーンの申告を受付済み",
    customer_reported_wrong_token: "誤トークンの申告を受付済み",
    unverified_report: "確認依頼を受付済み（未検証）",
    verified_match: "指定チェーンの取引を確認済み",
  };
  if (el.recoveryStatus) {
    el.recoveryStatus.textContent = status
      ? `${labels[status] || "確認依頼を受付済み"}。追加送金は行わず、店舗スタッフの案内をお待ちください。`
      : state.recoveryChains.length > 0
        ? "送金済み取引の確認が必要な場合に入力してください。"
        : "確認依頼に利用できるチェーン情報を確認できません。追加送金せず、店舗スタッフへお声がけください。";
  }
  if (el.submitRecoveryBtn) {
    el.submitRecoveryBtn.disabled = state.recoverySubmitting
      || !signedRecoveryPath()
      || state.recoveryChains.length === 0;
    el.submitRecoveryBtn.textContent = state.recoverySubmitting
      ? "確認依頼を送信中"
      : "送金済み取引を確認依頼する";
  }
}

function renderCustomerAction(invoice) {
  const recoveryStatus = String(invoice?.payment_recovery?.status || "");
  if ([
    "verified_wrong_chain",
    "verified_wrong_token",
    "customer_reported_wrong_chain",
    "customer_reported_wrong_token",
    "unverified_report",
  ].includes(recoveryStatus)) {
    const verified = recoveryStatus.startsWith("verified_");
    setCustomerActionBadge(verified ? "要確認" : "申告受付済み", verified ? "s-red" : "s-yellow");
    el.customerActionTitle.textContent = verified
      ? "送金内容について店舗での確認が必要です"
      : "送金内容の確認依頼を受け付けました";
    el.customerActionBody.textContent = verified
      ? "誤チェーン・誤トークンの可能性を確認済みです。追加送金や自分での資産移動は行わず、店舗スタッフの案内をお待ちください。"
      : "この申告だけでは支払い確認は完了していません。追加送金せず、店舗スタッフの確認をお待ちください。";
    el.customerActionList.innerHTML = "";
    for (const item of [
      "追加送金や再送信は行わないでください。",
      "シードフレーズや秘密鍵を誰にも渡さないでください。",
      "この画面を店舗スタッフへ見せてください。",
    ]) {
      const li = document.createElement("li");
      li.textContent = item;
      el.customerActionList.appendChild(li);
    }
    state.manualActionHint = el.customerActionBody.textContent;
    return;
  }
  if (hasIntegrityHold(invoice)) {
    setCustomerActionBadge("要確認", "s-red");
    el.customerActionTitle.textContent = "支払い記録を確認中です。追加送金はしないでください";
    el.customerActionBody.textContent = "チェーン再編成または支払い記録の整合性確認が完了するまで、支払い完了とは扱いません。店舗スタッフへお声がけください。";
    el.customerActionList.innerHTML = "";
    for (const item of [
      "追加送金や再送信は行わないでください。",
      "この画面をスタッフに見せてください。",
      "確認が完了するまで商品・サービスの案内に従ってください。",
    ]) {
      const li = document.createElement("li");
      li.textContent = item;
      el.customerActionList.appendChild(li);
    }
    state.manualActionHint = el.customerActionBody.textContent;
    return;
  }
  const status = canonicalInvoiceStatus(invoice?.status);
  if (["paid", "settled"].includes(status) && !hasFreshInvoiceObservation(invoice)) {
    setCustomerActionBadge("状態保留", "s-yellow");
    el.customerActionTitle.textContent = "最新の支払い状態を確認できません";
    el.customerActionBody.textContent = "再取得が成功するまで、この画面を支払い完了の根拠として使わず、店舗スタッフへお声がけください。";
    el.customerActionList.innerHTML = "";
    for (const item of [
      "追加送金や再送信は行わないでください。",
      "「最新の状態に更新」を押して再取得してください。",
      "再取得できない場合は店舗スタッフにこの画面を見せてください。",
    ]) {
      const li = document.createElement("li");
      li.textContent = item;
      el.customerActionList.appendChild(li);
    }
    state.manualActionHint = el.customerActionBody.textContent;
    return;
  }
  const customerMode = invoice?.customer_payment_mode || {};
  if (customerMode.mode && customerMode.mode !== "wallet_qr") {
    const customerModeBadge = customerMode.mode === "tap_processing"
      ? { label: "確認中", tone: "s-blue" }
      : customerMode.mode === "tap_retry"
        ? { label: "再案内", tone: "s-yellow" }
        : customerMode.mode === "tap_review"
          ? { label: "要確認", tone: "s-red" }
          : { label: "店頭案内", tone: "s-blue" };
    setCustomerActionBadge(customerModeBadge.label, customerModeBadge.tone);
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
      tone: "s-blue",
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
      tone: "s-blue",
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
      tone: "s-blue",
      title: "送金は受け付け済みです。このままお待ちください",
      body: "状態更新中です。追加送金や再送信は行わず、画面の更新をお待ちください。",
      items: [
        "二重送信は不要です。",
        "画面は自動更新されます。",
        "長く変わらない場合は店舗スタッフへお声がけください。",
      ],
    },
    confirming: {
      badge: "確認中",
      tone: "s-blue",
      title: "支払い内容を確認中です",
      body: "送金後の確認中です。処理が完了するまで数十秒ほどかかる場合があります。",
      items: [
        "追加送金は行わずに待ちます。",
        "この画面を開いたままにします。",
        "困ったときは店舗スタッフに声をかけてください。",
      ],
    },
    paid: {
      badge: "完了",
      tone: "s-green",
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
      tone: "s-green",
      title: "支払いを確認しました",
      body: "必要な確認が完了しています。追加操作は不要です。",
      items: [
        "必要な確認が終わっていれば画面を閉じて問題ありません。",
        "請求 ID は明細確認に使えます。",
        "不明点があれば店舗スタッフにお声がけください。",
      ],
    },
    review_required: {
      badge: "要確認",
      tone: "s-yellow",
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
      tone: "s-red",
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
      tone: "s-red",
      title: "この請求は無効です",
      body: "この請求では支払えません。店舗スタッフへ新しい請求を依頼してください。",
      items: [
        "この請求への送金はしないでください。",
        "必要なら新しい QR を受け取ってください。",
        "不明点があればスタッフへお声がけください。",
      ],
    },
  };

  const action = actionMap[status] || {
    badge: "状態確認中",
    tone: "s-yellow",
    title: "送金せず、最新状態の確認をお待ちください",
    body: "請求状態を安全に判定できないため、すべての支払い操作を停止しています。",
    items: [
      "送金・再送金は行わないでください。",
      "最新の状態が取得できるまでお待ちください。",
      "長く変わらない場合は店舗スタッフへお声がけください。",
    ],
  };
  setCustomerActionBadge(action.badge, action.tone);
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
  if (el.remainingText.textContent !== remaining) el.remainingText.textContent = remaining;
  const totalSec = remainingSeconds(expiresAt);
  if (totalSec == null) return;
  let threshold = null;
  for (let index = REMAINING_ANNOUNCEMENT_THRESHOLDS_SEC.length - 1; index >= 0; index -= 1) {
    const candidate = REMAINING_ANNOUNCEMENT_THRESHOLDS_SEC[index];
    if (totalSec <= candidate) {
      threshold = candidate;
      break;
    }
  }
  if (threshold == null || threshold === state.announcedRemainingThreshold) return;
  state.announcedRemainingThreshold = threshold;
  if (threshold === 0) {
    announce("支払い期限に達しました。送金しないでください。");
    return;
  }
  const label = threshold >= 60 ? `${Math.floor(threshold / 60)}分` : `${threshold}秒`;
  announce(`支払い期限まで残り${label}以内です。`);
}

function renderPaymentConditions(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status) || "issued";
  const show = WAITING_STATUSES.has(status);
  el.paymentConditionsCard.classList.toggle("hidden", !show);
  if (!show) return;
  const network = getNetwork(invoice);
  const chainId = invoice?.chain_id || "-";
  const token = getTokenSymbol(invoice) || "JPYC";
  const nativeSymbol = getNativeSymbol(invoice);
  el.paymentConditionsList.innerHTML = "";
  const items = [
    `対応チェーン: ${network}（チェーンID: ${chainId}）／支払いトークン: ${token}`,
    `ガス代（${nativeSymbol}）がウォレットに必要です。${nativeSymbol}残高が不足していると送金できません。`,
  ];
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    el.paymentConditionsList.appendChild(li);
  }
}

function renderPaymentVerification(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status) || "issued";
  const show = WAITING_STATUSES.has(status);
  if (!el.paymentVerifyCard) return;
  el.paymentVerifyCard.classList.toggle("hidden", !show);
  if (!show) return;
  const network = getNetwork(invoice);
  const chainId = invoice?.chain_id || "-";
  const token = getTokenSymbol(invoice) || "JPYC";
  const tokenContract = getOfficialTokenContract(invoice);
  const receiveAddress = getReceiveAddress(invoice);
  el.verifyNetworkText.textContent = `${network}（チェーンID: ${chainId}）`;
  el.verifyTokenText.textContent = token;
  el.tokenContractText.textContent = tokenContract || "-";
  el.tokenContractText.title = tokenContract || "";
  el.verifyAddressText.textContent = receiveAddress || "-";
  el.verifyAddressText.title = receiveAddress || "";
  if (el.manualRiskText && !state.manualRiskVisible) {
    el.manualRiskText.textContent = `ウォレット画面で「${network}」「${token}」「公式JPYCコントラクト」「この画面の送金先」がすべて一致していることを確認してから送信してください。`;
  }
}

function getReceiptEvidence(invoice) {
  const signedReceipt = invoice?.receipt && typeof invoice.receipt === "object"
    ? invoice.receipt
    : null;
  const txHash = String(invoice?.paid_tx_hash || "").trim();
  const chainRecordedAt = String(invoice?.chain_recorded_at || "").trim();
  const confirmedAt = String(invoice?.confirmed_at || "").trim();
  const confirmedAtMs = confirmedAt ? new Date(confirmedAt).getTime() : NaN;
  return {
    signedReceipt,
    txHash,
    chainRecordedAt,
    confirmedAt,
    complete: Boolean(signedReceipt?.signature)
      && Boolean(signedReceipt?.kid)
      && Boolean(signedReceipt?.content_sha256)
      && Boolean(signedReceipt?.tx_hash)
      && Number.isFinite(confirmedAtMs),
  };
}

function renderReceiptCard(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status);
  const isPaid = !hasIntegrityHold(invoice)
    && hasFreshInvoiceObservation(invoice)
    && (status === "paid" || status === "settled");
  el.receiptCard.classList.toggle("hidden", !isPaid);
  el.copyReceiptBtn.disabled = !isPaid;
  if (!isPaid) return;
  const evidence = getReceiptEvidence(invoice);
  el.receiptTitle.textContent = "お支払い確認情報";
  el.receiptStatusBadge.textContent = evidence.complete
    ? "支払い確認済み"
    : "確認情報を準備中";
  el.receiptStatusBadge.className = `status-pill ${evidence.complete ? "s-green" : "s-yellow"}`;
  el.receiptStoreName.textContent = invoice.store_name || "加盟店";
  el.receiptAmount.textContent =
    `${formatJpy(invoice.amount_jpy)} / ${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`;
  el.receiptInvoiceId.textContent = invoice.invoice_no || invoice.invoice_id || "-";
  el.receiptTxHash.textContent = evidence.txHash || "サーバー確認待ち";
  el.receiptChainRecordedAt.textContent = evidence.chainRecordedAt ? formatDateTime(evidence.chainRecordedAt) : "チェーン時刻なし";
  el.receiptConfirmedAt.textContent = evidence.complete ? formatDateTime(evidence.confirmedAt) : "サーバー確認待ち";
  el.receiptEvidenceNotice.textContent = evidence.complete
    ? "サーバーが発行した確認情報です。取引番号と確認日時を確認できます。"
    : "確認情報を準備しています。取引番号と確認日時が揃うまで、店舗スタッフへこの画面をお見せください。";
  el.copyReceiptBtn.textContent = evidence.complete ? "確認情報をコピー" : "状況メモをコピー";
  el.copyReceiptBtn.setAttribute("aria-label", evidence.complete ? "お支払い確認情報をコピー" : "確認中のお支払い状況をコピー");
}

function renderStatus(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status);
  const hold = hasIntegrityHold(invoice);
  const observationUnavailable = ["paid", "settled"].includes(status) && !hasFreshInvoiceObservation(invoice);
  const unknownStatus = !STATUS_COPY[status] && !hold;
  const meta = observationUnavailable ? {
    label: "最新状態を確認中",
    pill: "s-red",
    title: "再取得できるまで支払い完了として扱えません。",
  } : hold ? {
    label: "整合性確認中",
    pill: "s-red",
    title: "支払い記録を確認中です。追加送金はしないでください。",
  } : STATUS_COPY[status] || {
    label: "状態確認中",
    pill: "s-gray",
    title: "支払い状況を確認中です。",
  };
  if (el.statusPill.textContent !== meta.label) el.statusPill.textContent = meta.label;
  const statusClass = `status-pill ${meta.pill}`;
  if (el.statusPill.className !== statusClass) el.statusPill.className = statusClass;
  if (el.uxStateLabel.textContent !== meta.title) el.uxStateLabel.textContent = meta.title;
  if (unknownStatus) {
    const detail = "不明な状態です。確認のため自動更新を継続しています。支払い操作は停止しています。";
    if (el.uxStateDetail.textContent !== detail) el.uxStateDetail.textContent = detail;
    return;
  }
  const detail = observationUnavailable
    ? "最新の請求状態を取得できません。追加送金せず、再取得または店舗スタッフの確認をお待ちください。"
    : hold
    ? "チェーン再編成または支払い記録の確認中です。店舗スタッフへお声がけください。"
    : state.manualActionHint || "";
  if (el.uxStateDetail.textContent !== detail) el.uxStateDetail.textContent = detail;
}

function renderInvoice(invoice) {
  const nextInvoiceId = String(invoice?.invoice_id || "");
  if (nextInvoiceId !== state.lastAnnouncementInvoiceId) {
    state.lastAnnouncementInvoiceId = nextInvoiceId;
    state.announcedRemainingThreshold = null;
    state.manualRiskVisible = false;
  }
  applyPolicySnapshot(invoice);
  state.storeTimezone = safeTimeZone(invoice?.store_timezone);
  state.invoice = invoice;
  state.manualActionHint = buildPaymentMethodHint(invoice);
  const status = canonicalInvoiceStatus(invoice?.status);

  el.storeText.textContent = invoice.store_name || "加盟店";
  if (el.merchantTrustBadge) el.merchantTrustBadge.textContent = invoice.store_name ? "サーバー発行済み" : "発行元確認中";
  if (el.issuedAtText) el.issuedAtText.textContent = formatDateTime(invoice.issued_at || invoice.created_at);
  el.amountText.textContent = formatJpy(invoice.amount_jpy);
  el.amountSubText.textContent = `${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`;
  el.expiresText.textContent = formatDateTime(invoice.expires_at);
  updateRemainingAnnouncement(invoice.expires_at);

  renderCustomerAction(invoice);
  renderPaymentRecovery(invoice);
  renderWalletSupport(invoice);
  renderPaymentConditions(invoice);
  renderPaymentVerification(invoice);
  renderConsentGate(invoice);
  renderReceiptCard(invoice);
  renderStatus(invoice);

  el.networkText.textContent = getNetwork(invoice);
  const receiveAddress = getReceiveAddress(invoice);
  el.toText.textContent = state.addressExpanded ? (receiveAddress || "-") : middleEllipsis(receiveAddress);
  el.toText.title = receiveAddress || "";
  el.invoiceText.textContent = invoice.invoice_no || invoice.invoice_id || "-";
  el.txHashText.textContent = invoice.paid_tx_hash || "-";

  applyPaymentActionGate(invoice);
  if (el.toggleAddressBtn) {
    el.toggleAddressBtn.disabled = !receiveAddress;
    el.toggleAddressBtn.textContent = state.addressExpanded ? "支払い先を短縮表示" : "支払い先を全文表示";
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
    `公式JPYCコントラクト: ${getOfficialTokenContract(invoice) || "-"}`,
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
    await navigator.clipboard.writeText(value);
    return;
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

function setMethodPanel(visible, message, trigger = null) {
  const panel = el.methodPanel;
  if (!panel) return;
  if (visible) {
    state.methodPanelReturnFocus = trigger || document.activeElement;
    if (message) el.methodPanelText.textContent = message;
    panel.classList.remove("hidden");
    if (typeof panel.showModal === "function" && !panel.open) panel.showModal();
    window.setTimeout(() => el.closeMethodsBtn?.focus(), 0);
    return;
  }
  if (typeof panel.showModal === "function") {
    if (panel.open) panel.close();
  }
  panel.classList.add("hidden");
  const returnFocus = state.methodPanelReturnFocus;
  state.methodPanelReturnFocus = null;
  window.setTimeout(() => returnFocus?.focus?.(), 0);
}

function isMethodPanelOpen() {
  return Boolean(el.methodPanel && (el.methodPanel.open || !el.methodPanel.classList.contains("hidden")));
}

function explainPaymentGate(gate = evaluatePaymentActionGate()) {
  if (gate.code === "consent_required") {
    announceConsentRequired();
    return;
  }
  if (gate.code === "store_guidance") {
    setMethodPanel(true, gate.message);
  }
  if (gate.blockingMessage) showError("");
  else showError(gate.message);
  announce(gate.message);
}

function setLaunchInProgress(inProgress) {
  state.launchInProgress = Boolean(inProgress);
  applyPaymentActionGate(state.invoice);
}

function launchWalletOnce(invoice) {
  const candidate = buildWalletLaunchTarget(invoice);
  if (!candidate) return false;
  location.href = candidate.url;
  window.setTimeout(() => {
    if (document.visibilityState === "hidden" || !state.launchInProgress) return;
    setLaunchInProgress(false);
    setMethodPanel(
      true,
      "ウォレットが開かなかった場合は、自動で別のアプリを起動しません。「支払い情報をコピー」または「手動送金を表示」を選んでください。"
    );
    announce("ウォレットが開かなかった場合の手動送金案内を表示しました");
  }, WALLET_RECOVERY_DELAY_MS);
  return true;
}

async function submitPaymentRecovery() {
  const path = signedRecoveryPath();
  const txHash = String(el.recoveryTxHash?.value || "").trim().toLowerCase();
  const chainId = String(el.recoveryChainId?.value || "").trim();
  const reportedIssue = String(el.recoveryIssue?.value || "").trim();
  const chainIsAllowed = state.recoveryChains.some((chain) => chain.chainId === chainId);
  if (!path || !chainIsAllowed) {
    const error = Object.assign(new Error("unsupported recovery chain"), {
      customerCode: state.recoveryChains.length > 0
        ? "UNSUPPORTED_PAYMENT_CHAIN"
        : "PAYMENT_RECOVERY_UNAVAILABLE",
    });
    const message = customerFacingError(error, "PAYMENT_RECOVERY_UNAVAILABLE");
    if (el.recoveryStatus) el.recoveryStatus.textContent = message;
    showError(message);
    announce("利用できるチェーン情報を確認してください");
    return;
  }
  if (!/^(?:0x)?[0-9a-f]{64}$/.test(txHash)) {
    if (el.recoveryStatus) el.recoveryStatus.textContent = "チェーンと0xから始まる64桁の取引番号を入力してください。";
    announce("チェーンと取引番号を確認してください");
    return;
  }
  state.recoverySubmitting = true;
  renderPaymentRecovery(state.invoice);
  const controller = new AbortController();
  let requestTimedOut = false;
  const timeoutId = window.setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, MOBILE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain_id: chainId,
        tx_hash: txHash.startsWith("0x") ? txHash : `0x${txHash}`,
        reported_issue: reportedIssue || undefined,
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw customerErrorFromResponse(data, "INVOICE_REFRESH_FAILED");
    if (el.recoveryStatus) {
      el.recoveryStatus.textContent = data.status === "unverified_report"
        ? "確認依頼を受付しました。現在は未検証です。追加送金せず、店舗スタッフの案内をお待ちください。"
        : "確認依頼を受付しました。追加送金せず、店舗スタッフの案内をお待ちください。";
    }
    announce("送金済み取引の確認依頼を受付しました");
    await loadInvoice({ silent: true, force: true });
  } catch (error) {
    const effectiveError = requestTimedOut
      ? Object.assign(new Error("payment recovery timed out"), { customerCode: "PAYMENT_RECOVERY_TIMEOUT" })
      : error;
    const message = customerFacingError(effectiveError, "INVOICE_REFRESH_FAILED");
    if (el.recoveryStatus) el.recoveryStatus.textContent = message;
    showError(message);
  } finally {
    window.clearTimeout(timeoutId);
    state.recoverySubmitting = false;
    renderPaymentRecovery(state.invoice);
  }
}

async function refreshAfterBrowserRecovery() {
  const result = await loadInvoice({ silent: true, force: true });
  if (result?.ok) setLaunchInProgress(false);
  return result;
}

async function getFreshPayableInvoiceForAction() {
  const initialGate = applyPaymentActionGate();
  if (!initialGate.allowed) {
    explainPaymentGate(initialGate);
    return null;
  }
  const refreshResult = await loadInvoice({ silent: true, force: true });
  if (!refreshResult?.ok) return null;
  const refreshedGate = applyPaymentActionGate(refreshResult.invoice);
  if (!refreshedGate.allowed) {
    explainPaymentGate(refreshedGate);
    return null;
  }
  return refreshResult.invoice;
}

async function handleWalletPay() {
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  const initialGate = applyPaymentActionGate();
  if (!initialGate.allowed) {
    explainPaymentGate(initialGate);
    return;
  }

  setLaunchInProgress(true);
  const refreshResult = await loadInvoice({ silent: true, force: true });
  setLaunchInProgress(false);
  if (!refreshResult?.ok) return;

  const invoice = refreshResult.invoice;
  const refreshedGate = applyPaymentActionGate(invoice);
  if (!refreshedGate.allowed) {
    explainPaymentGate(refreshedGate);
    return;
  }
  const launchTarget = buildWalletLaunchTarget(invoice);
  if (!launchTarget) {
    showManualRiskWarning(invoice);
    setMethodPanel(true, buildManualPaymentInstructions(invoice, { includeHelp: true }), el.walletPayBtn);
    announce("手動送金の案内を表示しました");
    return;
  }
  setMethodPanel(true, "選択されたウォレットを1回だけ開きます。内容をご確認のうえ送金してください。", el.walletPayBtn);
  announce("ウォレットを開きます");
  setLaunchInProgress(true);
  launchWalletOnce(invoice);
}

function announceConsentRequired() {
  showError("利用規約・ポリシーをご確認のうえ、チェックを入れてください。");
  focusConsentGate();
  announce("同意が必要です");
}

async function handleCopyInfo() {
  if (!state.invoice) return;
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  const invoice = await getFreshPayableInvoiceForAction();
  if (!invoice) return;
  try {
    await copyText(buildCopyPayload(invoice));
    setMethodPanel(true, "支払い情報をコピーしました。ウォレットで内容を確認して送金してください。", el.copyInfoBtn);
    announce("支払い情報をコピーしました");
  } catch (error) {
    showError(customerFacingError(error, "COPY_FAILED"));
  }
}

async function handleCopyAddress() {
  if (!state.invoice) return;
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  const invoice = await getFreshPayableInvoiceForAction();
  if (!invoice) return;
  try {
    await copyText(getCopyFallback(invoice).copy_receive_address || getReceiveAddress(invoice) || "");
    announce("支払い先をコピーしました");
  } catch (error) {
    showError(customerFacingError(error, "COPY_FAILED"));
  }
}

async function handleCopyTokenContract() {
  if (!state.invoice) return;
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  const invoice = await getFreshPayableInvoiceForAction();
  if (!invoice) return;
  try {
    await copyText(getOfficialTokenContract(invoice));
    announce("公式JPYCコントラクトをコピーしました");
  } catch (error) {
    showError(customerFacingError(error, "COPY_FAILED"));
  }
}

async function handleCopyAmount() {
  if (!state.invoice) return;
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  const invoice = await getFreshPayableInvoiceForAction();
  if (!invoice) return;
  try {
    await copyText(`${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`);
    announce("金額をコピーしました");
  } catch (error) {
    showError(customerFacingError(error, "COPY_FAILED"));
  }
}

async function handleCopyInvoice() {
  if (!state.invoice) return;
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  const invoice = await getFreshPayableInvoiceForAction();
  if (!invoice) return;
  try {
    await copyText(invoice.invoice_no || invoice.invoice_id || "");
    announce("請求IDをコピーしました");
  } catch (error) {
    showError(customerFacingError(error, "COPY_FAILED"));
  }
}

async function handleShowMethods() {
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  const invoice = await getFreshPayableInvoiceForAction();
  if (!invoice) return;
  const visible = !isMethodPanelOpen();
  setMethodPanel(visible, visible ? buildManualPaymentInstructions(invoice, { includeHelp: true }) : "", el.showMethodsBtn);
  if (visible && !buildWalletLaunchTarget(invoice)) showManualRiskWarning(invoice);
  announce(visible ? "支払い方法を表示しました" : "支払い方法を閉じました");
}

async function handleCopyReceipt() {
  const invoice = state.invoice;
  if (!invoice) return;
  const status = canonicalInvoiceStatus(invoice.status);
  if (hasIntegrityHold(invoice)
    || !hasFreshInvoiceObservation(invoice)
    || !["paid", "settled"].includes(status)) {
    showError("最新の支払い状態を確認できないため、確認書はコピーできません。再取得してください。");
    announce("最新状態を再取得するまで確認書はコピーできません");
    return;
  }
  try {
    const evidence = getReceiptEvidence(invoice);
    const copyTimestamp = formatDateTime(new Date().toISOString());
    const lines = [
      evidence.complete ? "【お支払い確認情報】" : "【お支払い状況メモ（確認中）】",
      `店舗: ${invoice.store_name || "加盟店"}`,
      `金額: ${formatJpy(invoice.amount_jpy)} / ${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`,
      `請求ID: ${invoice.invoice_no || invoice.invoice_id || "-"}`,
      `取引番号: ${evidence.txHash || "サーバー確認待ち"}`,
      `チェーン記録日時: ${evidence.chainRecordedAt ? formatDateTime(evidence.chainRecordedAt) : "チェーン時刻なし"}`,
      `サーバー確認日時: ${evidence.complete ? formatDateTime(evidence.confirmedAt) : "サーバー確認待ち"}`,
      `コピー日時: ${copyTimestamp}`,
    ];
    await copyText(lines.join("\n"));
    announce(evidence.complete ? "お支払い確認情報をコピーしました" : "確認中のお支払い状況をコピーしました");
  } catch (error) {
    showError(customerFacingError(error, "COPY_FAILED"));
  }
}

async function loadInvoice(options = {}) {
  const { silent = false, fromPolling = false, force = false } = options;
  if (state.pollInFlight && fromPolling && !force) return { ok: false, skipped: true };
  const path = signedInvoicePath();
  if (!path) {
    clearAutomaticRetry();
    stopPolling();
    failClosedInvoiceObservation();
    setBlockingWarning("このURLは無効です。署名付きの支払いURLを確認するまで、すべての支払い操作を停止しています。");
    el.statusPill.textContent = "無効なURL";
    el.statusPill.className = "status-pill s-red";
    el.uxStateLabel.textContent = "この支払いURLは利用できません";
    el.uxStateDetail.textContent = "送金せず、店舗スタッフから新しい支払いURLを受け取ってください。";
    el.customerActionBadge.textContent = "支払い停止";
    el.customerActionBadge.className = "status-pill s-red";
    el.customerActionTitle.textContent = "送金しないでください";
    el.customerActionBody.textContent = state.blockingWarning;
    el.customerActionList.replaceChildren();
    for (const item of ["このURLでは支払いできません。", "表示中の支払い情報をコピー・利用しないでください。", "店舗スタッフへ新しい支払いURLを依頼してください。"]) {
      const li = document.createElement("li");
      li.textContent = item;
      el.customerActionList.appendChild(li);
    }
    applyPaymentActionGate(null);
    renderErrorBanner();
    return { ok: false, invalidPath: true };
  }
  const requestSequence = state.refreshSequence + 1;
  state.refreshSequence = requestSequence;
  if (state.refreshController) state.refreshController.abort();
  const controller = new AbortController();
  state.refreshController = controller;
  let requestTimedOut = false;
  const requestTimeoutId = window.setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, MOBILE_REQUEST_TIMEOUT_MS);
  state.pollInFlight = true;
  state.refreshInProgress = true;
  applyPaymentActionGate(state.invoice);
  const requestStartedAtMs = Date.now();
  try {
    const response = await fetch(path, { signal: controller.signal, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (requestSequence !== state.refreshSequence) return { ok: false, stale: true };
    if (!response.ok) {
      throw customerErrorFromResponse(data, "INVOICE_REFRESH_FAILED");
    }
    if (String(data.invoice_id || "") !== String(invoiceId || "")) {
      throw new Error("請求IDが一致しない応答を受け取りました。");
    }
    updateServerClock(response, requestStartedAtMs, data.server_now);
    state.lastRefreshSucceeded = true;
    state.lastRefreshInvoiceId = String(data.invoice_id || "");
    state.lastRefreshAtMs = Date.now();
    state.automaticRetryCount = 0;
    clearAutomaticRetry();
    state.refreshInProgress = false;
    showError("");
    renderInvoice(data);
    scheduleObservationFreshnessHold();
    if (!silent) announce(`現在の状態は ${el.statusPill.textContent} です`);
    return { ok: true, invoice: data };
  } catch (error) {
    if ((error?.name === "AbortError" && !requestTimedOut) || requestSequence !== state.refreshSequence) {
      return { ok: false, aborted: true };
    }
    const effectiveError = requestTimedOut
      ? Object.assign(new Error("invoice refresh timed out"), { customerCode: "INVOICE_REFRESH_FAILED" })
      : error;
    state.refreshInProgress = false;
    failClosedInvoiceObservation();
    setBlockingWarning("請求の最新状態を確認できないため、送金・手動送金・コピー操作を停止しています。再取得してください。");
    state.transientError = customerFacingError(effectiveError, "INVOICE_REFRESH_FAILED");
    renderErrorBanner();
    setMethodPanel(false, "");
    scheduleAutomaticRetry();
    if (!silent) announce("請求情報の取得に失敗しました");
    return { ok: false, error };
  } finally {
    window.clearTimeout(requestTimeoutId);
    if (requestSequence === state.refreshSequence) {
      state.pollInFlight = false;
      state.refreshInProgress = false;
      state.refreshController = null;
      applyPaymentActionGate(state.invoice);
    }
  }
}

function handleConsentChange() {
  state.consented = policyLinksReady() && Boolean(el.consentCheckbox?.checked);
  if (state.consented) {
    void recordConsent();
  } else {
    state.consentSequence += 1;
    if (state.consentController) state.consentController.abort();
    state.consentController = null;
    state.consentRecordStatus = "idle";
    state.consentRecordError = "";
  }
  if (state.invoice) {
    renderConsentGate(state.invoice);
    applyPaymentActionGate(state.invoice);
  }
}

function bindEvents() {
  if (el.consentCheckbox) el.consentCheckbox.addEventListener("change", handleConsentChange);
  if (el.retryConsentBtn) el.retryConsentBtn.addEventListener("click", () => void recordConsent());
  if (el.goToConsentBtn) el.goToConsentBtn.addEventListener("click", focusConsentGate);
  el.walletPayBtn.addEventListener("click", () => void handleWalletPay());
  el.showMethodsBtn.addEventListener("click", () => void handleShowMethods());
  if (el.closeMethodsBtn) el.closeMethodsBtn.addEventListener("click", () => setMethodPanel(false, ""));
  if (el.methodPanel) el.methodPanel.addEventListener("cancel", () => setMethodPanel(false, ""));
  el.copyInfoBtn.addEventListener("click", () => void handleCopyInfo());
  el.copyAddressBtn.addEventListener("click", () => void handleCopyAddress());
  el.copyTokenContractBtn.addEventListener("click", () => void handleCopyTokenContract());
  el.copyAmountBtn.addEventListener("click", () => void handleCopyAmount());
  el.copyInvoiceBtn.addEventListener("click", () => void handleCopyInvoice());
  el.copyReceiptBtn.addEventListener("click", () => void handleCopyReceipt());
  if (el.submitRecoveryBtn) el.submitRecoveryBtn.addEventListener("click", () => void submitPaymentRecovery());
  el.refreshBtn.addEventListener("click", () => {
    setLaunchInProgress(false);
    void loadInvoice({ silent: false, force: true });
  });
  if (el.retryLoadBtn) el.retryLoadBtn.addEventListener("click", () => {
    clearAutomaticRetry();
    state.automaticRetryCount = INITIAL_RETRY_DELAYS_MS.length;
    void loadInvoice({ silent: false, force: true });
  });
  el.closeErrorBannerBtn.addEventListener("click", () => {
    if (!state.blockingWarning) showError("");
  });
  if (el.toggleAddressBtn) {
    el.toggleAddressBtn.addEventListener("click", () => {
      state.addressExpanded = !state.addressExpanded;
      if (state.invoice) renderInvoice(state.invoice);
    });
  }
  window.addEventListener("beforeunload", () => {
    stopPolling();
    stopRemainingTimer();
    stopObservationFreshnessTimer();
    clearAutomaticRetry();
    if (state.refreshController) state.refreshController.abort();
    if (state.consentController) state.consentController.abort();
  });
  window.addEventListener("pageshow", () => {
    void refreshAfterBrowserRecovery();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshAfterBrowserRecovery();
  });
  window.addEventListener("online", () => void loadInvoice({ silent: true, force: true }));
}

bindEvents();
initPolicyLinks();
setMethodPanel(false, "");
void loadInvoice({ silent: false });
