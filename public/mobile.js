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

const INVOICE_STATUS_ALIASES = Object.freeze({
  manual_review: "review_required",
});

const POLL_INTERVAL_MS = 5000;
const FINAL_STATUSES = new Set(["paid", "settled", "review_required", "expired", "cancelled"]);
const WAITING_STATUSES = new Set(["issued", "open", "payment_detected", "confirming"]);

const STATUS_COPY = {
  issued: { label: "支払い待ち", pill: "s-blue", title: "送金をお待ちしています" },
  open: { label: "支払い待ち", pill: "s-blue", title: "送金をお待ちしています" },
  payment_detected: { label: "確認中", pill: "s-blue", title: "支払いを確認中です" },
  confirming: { label: "確認中", pill: "s-blue", title: "支払いを確認中です" },
  paid: { label: "支払い確認済み", pill: "s-green", title: "支払いを確認しました" },
  settled: { label: "確定済み", pill: "s-green", title: "支払いは確定済みです" },
  review_required: { label: "確認が必要", pill: "s-yellow", title: "確認が必要な支払いです。店舗スタッフにお声がけください。" },
  expired: { label: "期限切れ", pill: "s-red", title: "この請求は期限切れです" },
  cancelled: { label: "無効", pill: "s-red", title: "この請求は無効です" },
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
  consented: false,
  consentRecordId: "",
};

const el = {
  liveStatus: document.getElementById("liveStatus"),
  errorBanner: document.getElementById("errorBanner"),
  errorBannerText: document.getElementById("errorBannerText"),
  closeErrorBannerBtn: document.getElementById("closeErrorBannerBtn"),
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
  customerActionBadge: document.getElementById("customerActionBadge"),
  customerActionTitle: document.getElementById("customerActionTitle"),
  customerActionBody: document.getElementById("customerActionBody"),
  customerActionList: document.getElementById("customerActionList"),
  walletAvailabilityBadge: document.getElementById("walletAvailabilityBadge"),
  supportedWalletChips: document.getElementById("supportedWalletChips"),
  walletSupportText: document.getElementById("walletSupportText"),
  walletHelpLink: document.getElementById("walletHelpLink"),
  walletPayBtn: document.getElementById("walletPayBtn"),
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
  verifyAddressText: document.getElementById("verifyAddressText"),
  manualRiskText: document.getElementById("manualRiskText"),
  toggleAddressBtn: document.getElementById("toggleAddressBtn"),
  receiptCard: document.getElementById("receiptCard"),
  receiptStatusBadge: document.getElementById("receiptStatusBadge"),
  receiptStoreName: document.getElementById("receiptStoreName"),
  receiptAmount: document.getElementById("receiptAmount"),
  receiptInvoiceId: document.getElementById("receiptInvoiceId"),
  receiptTxHash: document.getElementById("receiptTxHash"),
  copyReceiptBtn: document.getElementById("copyReceiptBtn"),
  consentGateSection: document.getElementById("consentGateSection"),
  consentCheckbox: document.getElementById("consentCheckbox"),
  consentLiveStatus: document.getElementById("consentLiveStatus"),
  consentTermsLink: document.getElementById("consentTermsLink"),
  consentPrivacyLink: document.getElementById("consentPrivacyLink"),
  consentRefundLink: document.getElementById("consentRefundLink"),
};

function announce(message) {
  el.liveStatus.textContent = message || "";
}

function showError(message) {
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
  if (typeof href === "string" && href.trim()) {
    linkEl.href = href.trim();
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

function formatRemaining(expiresAt) {
  if (!expiresAt) return "期限情報を確認中です。";
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry)) return "期限情報を確認中です。";
  const remainMs = expiry - Date.now();
  if (remainMs <= 0) return "期限切れです。";
  const totalSec = Math.floor(remainMs / 1000);
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
      showError("この請求は期限切れです。送金せず、店舗スタッフに新しい請求を依頼してください。");
      el.remainingText.classList.add("attention-pulse");
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

function initPolicyLinks() {
  const policy = state.invoice?.policy || {};
  const urls = {
    terms: policy.terms_url || POLICY_URLS.terms,
    privacy: policy.privacy_url || POLICY_URLS.privacy,
    refund: policy.refund_policy_url || POLICY_URLS.refund,
  };
  if (el.consentTermsLink) el.consentTermsLink.href = urls.terms || "#";
  if (el.consentPrivacyLink) el.consentPrivacyLink.href = urls.privacy || "#";
  if (el.consentRefundLink) el.consentRefundLink.href = urls.refund || "#";
}

async function recordConsent() {
  const path = signedConsentPath();
  if (!path) throw new Error("同意記録URLが無効です。");
  const policy = state.invoice?.policy || {};
  const body = {
    terms_url: policy.terms_url || POLICY_URLS.terms,
    privacy_url: policy.privacy_url || POLICY_URLS.privacy,
    refund_policy_url: policy.refund_policy_url || POLICY_URLS.refund,
    terms_version: policy.terms_version || POLICY_VERSIONS.terms_version,
    privacy_version: policy.privacy_version || POLICY_VERSIONS.privacy_version,
    refund_policy_version: policy.refund_policy_version || POLICY_VERSIONS.refund_policy_version,
  };
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.consent_record_id) {
    throw new Error(data?.error?.message || "サーバー同意記録に失敗しました。");
  }
  state.consentRecordId = data.consent_record_id;
}

function renderConsentGate(invoice) {
  const needsConsent = WAITING_STATUSES.has(canonicalInvoiceStatus(invoice?.status));
  if (!el.consentGateSection) return;
  el.consentGateSection.classList.toggle("hidden", !needsConsent);
  if (!needsConsent) return;
  if (el.consentCheckbox) el.consentCheckbox.checked = state.consented;
  if (el.consentLiveStatus) {
    el.consentLiveStatus.textContent = state.consented
      ? "同意済みです。お支払い操作が可能です。"
      : "利用規約・ポリシーをご確認のうえ、チェックを入れてください。";
  }
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
  renderChipGroup(el.supportedWalletChips, supportedWallets, launchTarget ? "対応ウォレット確認中" : "手動送金も可能");

  if (launchTarget) {
    el.walletAvailabilityBadge.textContent = "起動導線あり";
    el.walletSupportText.textContent = "メインボタンからウォレット起動を試せます。起動しない場合は支払い情報コピーか手動送金案内をご利用ください。";
  } else if (adapter.reason) {
    el.walletAvailabilityBadge.textContent = "手動案内";
    el.walletSupportText.textContent = `自動起動が使えないため、手動送金をご案内します（${adapter.reason}）。`;
  } else {
    el.walletAvailabilityBadge.textContent = "コピー送金";
    el.walletSupportText.textContent = "支払い情報をコピーして、お使いのウォレットから送金してください。";
  }

  setHelperLink(el.walletHelpLink, invoice?.wallet_help_url || "", "ウォレット案内を開く");
}

function renderCustomerAction(invoice) {
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
  const status = canonicalInvoiceStatus(invoice?.status) || "issued";
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
  const minuteKey = remaining.replace(/秒$/, "");
  if (minuteKey !== state.announcedMinute) {
    state.announcedMinute = minuteKey;
    if (minuteKey.includes("残り")) {
      announce(`支払い期限 ${minuteKey}`);
    }
  }
}

function renderPaymentConditions(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status) || "issued";
  const show = WAITING_STATUSES.has(status);
  el.paymentConditionsCard.classList.toggle("hidden", !show);
  if (!show) return;
  const network = getNetwork(invoice) || "Polygon";
  const chainId = invoice?.chain_id || "137";
  const token = getTokenSymbol(invoice) || "JPYC";
  el.paymentConditionsList.innerHTML = "";
  const items = [
    `対応チェーン: ${network}（チェーンID: ${chainId}）／支払いトークン: ${token}`,
    "ガス代（MATIC）がウォレットに必要です。MATIC残高が不足していると送金できません。",
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
  const network = getNetwork(invoice) || "Polygon";
  const chainId = invoice?.chain_id || "137";
  const token = getTokenSymbol(invoice) || "JPYC";
  const receiveAddress = getReceiveAddress(invoice);
  el.verifyNetworkText.textContent = `${network}（チェーンID: ${chainId}）`;
  el.verifyTokenText.textContent = token;
  el.verifyAddressText.textContent = receiveAddress || "-";
  el.verifyAddressText.title = receiveAddress || "";
  if (el.manualRiskText && !state.manualRiskVisible) {
    el.manualRiskText.textContent = "ウォレット画面で「Polygon」「JPYC」「この画面の送金先」の3つが一致していることを確認してから送信してください。";
  }
}

function renderReceiptCard(invoice) {
  const status = canonicalInvoiceStatus(invoice?.status);
  initPolicyLinks();
  const isPaid = status === "paid" || status === "settled";
  el.receiptCard.classList.toggle("hidden", !isPaid);
  if (!isPaid) return;
  el.receiptStatusBadge.textContent = status === "settled" ? "確定済み" : "支払い確認済み";
  el.receiptStoreName.textContent = invoice.store_name || "加盟店";
  el.receiptAmount.textContent =
    `${formatJpy(invoice.amount_jpy)} / ${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`;
  el.receiptInvoiceId.textContent = invoice.invoice_no || invoice.invoice_id || "-";
  el.receiptTxHash.textContent = invoice.paid_tx_hash || "-";
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
  if (el.merchantTrustBadge) el.merchantTrustBadge.textContent = invoice.store_name ? "サーバー発行済み" : "発行元確認中";
  if (el.issuedAtText) el.issuedAtText.textContent = formatDateTime(invoice.issued_at || invoice.created_at);
  el.amountText.textContent = formatJpy(invoice.amount_jpy);
  el.amountSubText.textContent = `${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`;
  el.expiresText.textContent = formatDateTime(invoice.expires_at);
  updateRemainingAnnouncement(invoice.expires_at);

  renderCustomerAction(invoice);
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

  const customerMode = invoice?.customer_payment_mode || {};
  const paymentActionAvailable = WAITING_STATUSES.has(status) && (!customerMode.mode || customerMode.mode === "wallet_qr");
  const walletAllowed = paymentActionAvailable && state.consented && Boolean(state.consentRecordId);
  el.walletPayBtn.disabled = !walletAllowed;
  el.showMethodsBtn.disabled = !walletAllowed;
  el.copyInfoBtn.disabled = !walletAllowed;
  el.copyAddressBtn.disabled = !walletAllowed;
  el.copyAmountBtn.disabled = !walletAllowed;
  el.copyInvoiceBtn.disabled = !walletAllowed;
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

function setMethodPanel(visible, message) {
  el.methodPanel.classList.toggle("hidden", !visible);
  if (message) el.methodPanelText.textContent = message;
}

async function handleWalletPay() {
  const invoice = state.invoice;
  if (!invoice) {
    showError("請求情報を読み込み中です。");
    return;
  }
  if (invoice.customer_payment_mode?.mode && invoice.customer_payment_mode.mode !== "wallet_qr") {
    setMethodPanel(true, invoice.customer_payment_mode.body || "この会計は店頭端末でご案内します。");
    announce("店頭端末の案内をご確認ください");
    return;
  }
  if (!WAITING_STATUSES.has(canonicalInvoiceStatus(invoice.status))) {
    showError("現在の状態ではお支払いを開始できません。");
    return;
  }
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  const launchTarget = buildWalletLaunchTarget(invoice);
  if (!launchTarget) {
    showManualRiskWarning(invoice);
    setMethodPanel(true, buildManualPaymentInstructions(invoice, { includeHelp: true }));
    announce("手動送金の案内を表示しました");
    return;
  }
  const launchMessage = launchTarget.type === "wallet_deeplink"
    ? "ウォレット用の deeplink を開きます。内容をご確認のうえ送金してください。"
    : launchTarget.type === "payment_uri"
      ? "標準 payment URI でウォレット起動を試みます。内容をご確認のうえ送金してください。"
      : "ウォレット起動URLを開きます。内容をご確認のうえ送金してください。";
  setMethodPanel(true, launchMessage);
  announce("ウォレットを開きます");
  location.href = launchTarget.url;
}

function announceConsentRequired() {
  showError("利用規約・ポリシーをご確認のうえ、チェックを入れてください。");
  if (el.consentGateSection) {
    el.consentGateSection.classList.add("attention-pulse");
    el.consentGateSection.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => el.consentGateSection.classList.remove("attention-pulse"), 1400);
  }
  announce("同意が必要です");
}

async function handleCopyInfo() {
  if (!state.invoice) return;
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  try {
    await copyText(buildCopyPayload(state.invoice));
    setMethodPanel(true, "支払い情報をコピーしました。ウォレットで内容を確認して送金してください。");
    announce("支払い情報をコピーしました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

async function handleCopyAddress() {
  if (!state.invoice) return;
  if (!state.consented) {
    announceConsentRequired();
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
  if (!state.consented) {
    announceConsentRequired();
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
  if (!state.consented) {
    announceConsentRequired();
    return;
  }
  try {
    await copyText(state.invoice.invoice_no || state.invoice.invoice_id || "");
    announce("請求IDをコピーしました");
  } catch (error) {
    showError(String(error.message || error));
  }
}

async function handleCopyReceipt() {
  const invoice = state.invoice;
  if (!invoice) return;
  try {
    const lines = [
      "【お支払い確認書】",
      `店舗: ${invoice.store_name || "加盟店"}`,
      `金額: ${formatJpy(invoice.amount_jpy)} / ${toNumber(invoice.amount_jpyc).toLocaleString("ja-JP")} ${getTokenSymbol(invoice)}`,
      `請求ID: ${invoice.invoice_no || invoice.invoice_id || "-"}`,
      `取引番号: ${invoice.paid_tx_hash || "-"}`,
      `確認日時: ${formatDateTime(new Date().toISOString())}`,
    ];
    await copyText(lines.join("\n"));
    announce("お支払い確認書をコピーしました");
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
    showError("このURLは無効です。署名付きの支払いURLをご確認ください。");
    el.walletPayBtn.disabled = true;
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
    if (!silent) announce("請求情報の取得に失敗しました");
  } finally {
    state.pollInFlight = false;
  }
}

async function handleConsentChange() {
  const checked = Boolean(el.consentCheckbox?.checked);
  state.consented = false;
  state.consentRecordId = "";
  if (checked) {
    try {
      if (el.consentLiveStatus) el.consentLiveStatus.textContent = "同意をサーバーに記録しています。";
      await recordConsent();
      state.consented = true;
    } catch (error) {
      if (el.consentCheckbox) el.consentCheckbox.checked = false;
      showError(String(error.message || error));
    }
  }
  if (state.invoice) renderInvoice(state.invoice);
  if (el.consentLiveStatus) {
    el.consentLiveStatus.textContent = state.consented
      ? "同意済みです。お支払い操作が可能です。"
      : "利用規約・ポリシーをご確認のうえ、チェックを入れてください。";
  }
}

function bindEvents() {
  if (el.consentCheckbox) el.consentCheckbox.addEventListener("change", () => void handleConsentChange());
  el.walletPayBtn.addEventListener("click", () => void handleWalletPay());
  el.showMethodsBtn.addEventListener("click", () => {
    if (!state.consented) {
      announceConsentRequired();
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
  el.copyReceiptBtn.addEventListener("click", () => void handleCopyReceipt());
  el.refreshBtn.addEventListener("click", () => void loadInvoice({ silent: false }));
  el.closeErrorBannerBtn.addEventListener("click", () => showError(""));
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

bindEvents();
initPolicyLinks();
setMethodPanel(false, "");
void loadInvoice({ silent: false });
