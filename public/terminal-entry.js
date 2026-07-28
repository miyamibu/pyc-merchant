const query = new URLSearchParams(location.search);
const terminalToken = query.get("token");
const POLL_INTERVAL_MS = 3000;
const REQUEST_TIMEOUT_MS = 8000;
function getAnonymousDeviceId() {
  const storageKey = "jpyc_terminal_anonymous_device_id_v1";
  try {
    const existing = String(window.localStorage.getItem(storageKey) || "").trim();
    if (existing.length >= 8) return existing;
    const created = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem(storageKey, created);
    return created;
  } catch (_error) {
    return globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}
const ANONYMOUS_DEVICE_ID = getAnonymousDeviceId();

const state = {
  pollTimer: null,
  readyEntry: null,
  presentedFingerprint: "",
  requiresReconfirmation: false,
  refreshInFlight: false,
  opening: false,
  requestController: null,
  requestSequence: 0,
  claim: null,
  claimFingerprint: "",
};

const el = {
  liveStatus: document.getElementById("liveStatus"),
  entryBadge: document.getElementById("entryBadge"),
  storeText: document.getElementById("storeText"),
  headlineText: document.getElementById("headlineText"),
  bodyText: document.getElementById("bodyText"),
  helpList: document.getElementById("helpList"),
  entryReadyPanel: document.getElementById("entryReadyPanel"),
  entryAmountText: document.getElementById("entryAmountText"),
  entryInvoiceText: document.getElementById("entryInvoiceText"),
  openInvoiceBtn: document.getElementById("openInvoiceBtn"),
  refreshEntryBtn: document.getElementById("refreshEntryBtn"),
};

const TERMINAL_ENTRY_ERROR_CATALOG = Object.freeze({
  ENTRY_REFRESH_FAILED: {
    message: "会計状態を確認できません。通信状態を確認して、もう一度更新してください。",
    supportCode: "CUST-ENTRY-REFRESH",
  },
  ENTRY_TIMEOUT: {
    message: "会計状態の確認がタイムアウトしました。通信状態を確認して、もう一度更新してください。",
    supportCode: "CUST-ENTRY-TIMEOUT",
  },
  ENTRY_CLAIM_FAILED: {
    message: "この会計を確保できません。会計状態を更新して、もう一度確認してください。",
    supportCode: "CUST-ENTRY-CLAIM",
  },
  ENTRY_CONSUME_FAILED: {
    message: "この会計を確定できません。会計状態を更新して、もう一度確認してください。",
    supportCode: "CUST-ENTRY-CONSUME",
  },
  CHECKOUT_ALREADY_CLAIMED: {
    message: "この会計は別の端末で確認中です。追加操作をせず、店舗スタッフへお声がけください。",
    supportCode: "CUST-ENTRY-CLAIM-CONFLICT",
  },
  CHECKOUT_CLAIM_STALE: {
    message: "会計内容が更新されました。会計状態を更新して、表示内容を確認してください。",
    supportCode: "CUST-ENTRY-STALE",
  },
  CHECKOUT_CLAIM_EXPIRED: {
    message: "確認の有効時間が過ぎました。会計状態を更新して、もう一度確認してください。",
    supportCode: "CUST-ENTRY-EXPIRED",
  },
  CHECKOUT_CLAIM_DEVICE_MISMATCH: {
    message: "この端末では会計を確定できません。店舗スタッフへお声がけください。",
    supportCode: "CUST-ENTRY-DEVICE",
  },
  RATE_LIMITED: {
    message: "確認操作が集中しています。少し待ってから、もう一度お試しください。",
    supportCode: "CUST-ENTRY-RATE-LIMIT",
  },
  NOT_FOUND: {
    message: "この端末入口は現在利用できません。店舗スタッフへお声がけください。",
    supportCode: "CUST-ENTRY-NOT-FOUND",
  },
  PAY_DESTINATION_INVALID: {
    message: "安全確認に失敗したため、支払い画面を開けませんでした。店舗スタッフへお声がけください。",
    supportCode: "CUST-ENTRY-DESTINATION",
  },
});

function terminalEntryError(customerCode) {
  const error = new Error(String(customerCode || "ENTRY_REFRESH_FAILED"));
  error.customerCode = String(customerCode || "ENTRY_REFRESH_FAILED").toUpperCase();
  return error;
}

function terminalEntryErrorFromResponse(payload, fallbackCode) {
  const fallback = String(fallbackCode || "ENTRY_REFRESH_FAILED").toUpperCase();
  const serverCode = String(payload?.error?.code || "").trim().toUpperCase();
  const error = terminalEntryError(TERMINAL_ENTRY_ERROR_CATALOG[serverCode] ? serverCode : fallback);
  return error;
}

function customerFacingTerminalError(error, fallbackCode = "ENTRY_REFRESH_FAILED") {
  const fallback = String(fallbackCode || "ENTRY_REFRESH_FAILED").toUpperCase();
  const code = String(error?.customerCode || "").toUpperCase();
  const entry = TERMINAL_ENTRY_ERROR_CATALOG[code] || TERMINAL_ENTRY_ERROR_CATALOG[fallback] || TERMINAL_ENTRY_ERROR_CATALOG.ENTRY_REFRESH_FAILED;
  return `${entry.message}（問い合わせコード: ${entry.supportCode}）`;
}

function announce(message) {
  el.liveStatus.textContent = message || "";
}

function setBadge(label, klass) {
  el.entryBadge.textContent = label;
  el.entryBadge.className = `status-pill ${klass}`;
}

function setHelp(items) {
  el.helpList.innerHTML = "";
  const rows = Array.isArray(items) && items.length > 0 ? items : ["店舗スタッフへお声がけください。"];
  for (const item of rows) {
    const li = document.createElement("li");
    li.textContent = item;
    el.helpList.appendChild(li);
  }
}

function stopPolling() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function startPolling() {
  if (state.pollTimer || state.opening) return;
  state.pollTimer = setInterval(() => {
    void refreshEntryState({ silent: true });
  }, POLL_INTERVAL_MS);
}

function clearReadyState() {
  state.readyEntry = null;
  state.requiresReconfirmation = false;
  state.claim = null;
  state.claimFingerprint = "";
  el.entryReadyPanel.classList.add("hidden");
  el.entryAmountText.textContent = "-";
  el.entryInvoiceText.textContent = "-";
  el.openInvoiceBtn.disabled = true;
  el.openInvoiceBtn.textContent = "この会計を確認して進む";
}

function shortInvoiceReference(invoice) {
  const preferred = String(invoice?.invoice_no || "").trim();
  if (preferred) return preferred;
  const invoiceId = String(invoice?.invoice_id || "").trim();
  return invoiceId ? `…${invoiceId.slice(-8)}` : "-";
}

function readyFingerprint(entry) {
  const invoice = entry?.active_invoice || {};
  return [
    entry?.store_name,
    invoice.invoice_id,
    invoice.invoice_no,
    invoice.amount_jpy,
    invoice.amount_scale_version,
    invoice.token_amount_atomic,
    invoice.ledger_amount_base,
    invoice.invoice_version,
    entry?.pay_url,
  ]
    .map((value) => String(value || ""))
    .join("|");
}

async function requestEntryState() {
  if (!terminalToken) {
    throw terminalEntryError("ENTRY_REFRESH_FAILED");
  }
  const requestSequence = state.requestSequence + 1;
  state.requestSequence = requestSequence;
  if (state.requestController) state.requestController.abort();
  const controller = new AbortController();
  state.requestController = controller;
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/v1/public/terminal-entry/${encodeURIComponent(terminalToken)}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (requestSequence !== state.requestSequence) throw new DOMException("旧い応答を破棄しました", "AbortError");
    if (!response.ok) {
      throw terminalEntryErrorFromResponse(payload, "ENTRY_REFRESH_FAILED");
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw terminalEntryError("ENTRY_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (requestSequence === state.requestSequence) state.requestController = null;
  }
}

async function claimCurrentInvoice(entry) {
  const invoice = entry?.active_invoice || {};
  const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetch(`/api/v1/public/terminal-entry/${encodeURIComponent(terminalToken)}/claim`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anonymous_device_id: ANONYMOUS_DEVICE_ID,
      nonce,
      invoice_version: invoice.invoice_version,
      amount_scale_version: invoice.amount_scale_version,
      token_amount_atomic: invoice.token_amount_atomic,
      ledger_amount_base: invoice.ledger_amount_base,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw terminalEntryErrorFromResponse(payload, "ENTRY_CLAIM_FAILED");
  }
  return payload;
}

async function consumeCheckoutClaim(entry, claim) {
  const invoice = entry?.active_invoice || {};
  const response = await fetch(
    `/api/v1/public/terminal-entry/${encodeURIComponent(terminalToken)}/claim/${encodeURIComponent(claim.claim_id)}/consume`,
    {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anonymous_device_id: ANONYMOUS_DEVICE_ID,
        invoice_version: invoice.invoice_version,
        amount_scale_version: invoice.amount_scale_version,
        token_amount_atomic: invoice.token_amount_atomic,
        ledger_amount_base: invoice.ledger_amount_base,
      }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw terminalEntryErrorFromResponse(payload, "ENTRY_CONSUME_FAILED");
  return payload;
}

function isExpectedPayDestination(destination) {
  const keys = [...destination.searchParams.keys()];
  return destination.origin === window.location.origin
    && !destination.username
    && !destination.password
    && destination.pathname === "/pay"
    && !destination.hash
    && keys.length === 1
    && keys[0] === "ref"
    && destination.searchParams.getAll("ref").length === 1
    && Boolean(String(destination.searchParams.get("ref") || "").trim());
}

function renderWaiting(entry) {
  clearReadyState();
  setBadge("会計準備中", "s-blue");
  el.storeText.textContent = entry.store_name || "-";
  el.headlineText.textContent = "店舗側で会計を準備しています。";
  el.bodyText.textContent = "準備ができたら、この画面に会計内容と確認ボタンを表示します。";
  setHelp([
    "会計内容が表示されるまで、この画面のままお待ちください。",
    "会計がまだ立っていないため、支払い先や金額は表示されていません。",
    "長く進まない場合は、会計状態を更新するか店舗スタッフへお声がけください。",
  ]);
  announce("会計準備中です。");
}

function renderBlocked(entry) {
  clearReadyState();
  setBadge("要スタッフ確認", "s-yellow");
  el.storeText.textContent = entry.store_name || "-";
  el.headlineText.textContent = "店舗スタッフによる会計確認が必要です。";
  el.bodyText.textContent = "この端末で複数の会計が検出されたため、請求を自動で選択していません。";
  setHelp([
    "店舗スタッフが会計状態を確認するまでお待ちください。",
    "確認後は会計状態を更新すると、この画面から再開できます。",
    "この画面から秘密鍵やシードフレーズを入力することはありません。",
  ]);
  announce("店舗スタッフによる確認が必要です。");
}

function renderTapPresented(entry) {
  clearReadyState();
  setBadge("店頭案内中", "s-blue");
  el.storeText.textContent = entry.store_name || "-";
  el.headlineText.textContent = entry.customer_payment_mode?.title || "店頭端末でお支払いをご案内しています。";
  el.bodyText.textContent =
    entry.customer_payment_mode?.body || entry.message || "この会計は端末入口QRからのウォレット導線を一時停止しています。";
  setHelp([
    "カード・スマホをお使いの場合は、店舗スタッフの案内に従ってください。",
    "この端末入口QRから別の支払い方法へ切り替えることはできません。",
    "長く進まない場合は、会計状態を更新するか店舗スタッフへお声がけください。",
  ]);
  announce("店頭端末でお支払いをご案内しています。");
}

function renderReady(entry, { changed = false, requireReconfirmation = changed } = {}) {
  const invoice = entry.active_invoice || {};
  const fingerprint = readyFingerprint(entry);
  if (state.claim && state.claimFingerprint !== fingerprint) {
    state.claim = null;
    state.claimFingerprint = "";
  }
  const changedSinceConfirmation = Boolean(
    state.presentedFingerprint && fingerprint !== state.presentedFingerprint
  );
  const mustReconfirm = Boolean(requireReconfirmation || changedSinceConfirmation);
  const contentChanged = Boolean(changed || changedSinceConfirmation);
  state.readyEntry = entry;
  state.requiresReconfirmation = mustReconfirm;
  if (!state.presentedFingerprint && !mustReconfirm) state.presentedFingerprint = fingerprint;
  setBadge(contentChanged ? "内容更新" : "会計準備完了", contentChanged ? "s-yellow" : "s-green");
  el.storeText.textContent = entry.store_name || "-";
  el.headlineText.textContent = contentChanged ? "会計内容が更新されました。" : "お支払いに進めます。";
  el.bodyText.textContent = contentChanged
    ? "安全のため移動を止めました。店舗・金額・会計番号をもう一度確認してください。"
    : "店舗・金額・会計番号を確認し、内容が正しければ確認ボタンを押してください。";
  const amount = Number(invoice.amount_jpy);
  el.entryAmountText.textContent = Number.isFinite(amount) ? `¥${amount.toLocaleString("ja-JP")}` : "-";
  el.entryInvoiceText.textContent = shortInvoiceReference(invoice);
  el.entryReadyPanel.classList.remove("hidden");
  el.openInvoiceBtn.disabled = !entry.pay_url || state.opening;
  el.openInvoiceBtn.textContent = mustReconfirm
    ? "変更内容を確認"
    : state.claim?.invoice_id === invoice.invoice_id
      ? "確認して支払い画面へ"
      : "この会計を確認して進む";
  setHelp([
    "表示された店舗・金額・会計番号がご自身の会計か確認してください。",
    "確認ボタンを押す直前にも最新状態を照合します。",
    "内容に心当たりがない場合は進まず、店舗スタッフへお声がけください。",
  ]);
  announce(contentChanged ? "会計内容が更新されました。もう一度確認してください。" : "会計の準備ができました。内容を確認してください。");
}

function renderEntry(entry, options = {}) {
  if (entry.status === "ready") {
    renderReady(entry, options);
  } else if (entry.status === "blocked") {
    renderBlocked(entry);
  } else if (entry.status === "tap_presented") {
    renderTapPresented(entry);
  } else {
    renderWaiting(entry);
  }
}

async function refreshEntryState({ silent = false } = {}) {
  if (state.refreshInFlight || state.opening) return;
  state.refreshInFlight = true;
  el.refreshEntryBtn.disabled = true;
  try {
    const entry = await requestEntryState();
    renderEntry(entry);
    startPolling();
  } catch (error) {
    clearReadyState();
    setBadge("再確認中", "s-yellow");
    el.storeText.textContent = "-";
    el.headlineText.textContent = "会計状態を再確認しています。";
    el.bodyText.textContent = customerFacingTerminalError(error, "ENTRY_REFRESH_FAILED");
    if (!silent) {
      setHelp([
        "通信状態を確認して、会計状態を更新してください。",
        "長く進まない場合は、店舗スタッフへお声がけください。",
      ]);
    }
    announce("会計状態を再確認しています。");
    startPolling();
  } finally {
    state.refreshInFlight = false;
    el.refreshEntryBtn.disabled = false;
  }
}

async function handleOpenInvoice() {
  const selectedEntry = state.readyEntry;
  if (!selectedEntry?.pay_url || state.opening || state.refreshInFlight) return;
  if (state.requiresReconfirmation) {
    state.presentedFingerprint = readyFingerprint(selectedEntry);
    state.requiresReconfirmation = false;
    renderReady(selectedEntry);
    el.headlineText.textContent = "更新後の会計内容を確認しました。";
    el.bodyText.textContent = "表示中の店舗・金額・会計番号が正しければ確認ボタンを押してください。";
    announce("更新後の会計内容を確認しました。もう一度ボタンを押すと最新状態を照合して開きます。");
    return;
  }
  state.refreshInFlight = true;
  el.openInvoiceBtn.disabled = true;
  el.refreshEntryBtn.disabled = true;
  try {
    const latestEntry = await requestEntryState();
    if (latestEntry.status !== "ready") {
      renderEntry(latestEntry);
      announce("会計状態が変わったため、お支払い画面への移動を止めました。");
      return;
    }
    if (readyFingerprint(latestEntry) !== readyFingerprint(selectedEntry)) {
      renderReady(latestEntry, { changed: true, requireReconfirmation: true });
      return;
    }
    const latestFingerprint = readyFingerprint(latestEntry);
    if (!state.claim || state.claim.invoice_id !== latestEntry.active_invoice?.invoice_id) {
      const claim = await claimCurrentInvoice(latestEntry);
      state.claim = claim;
      state.claimFingerprint = latestFingerprint;
      state.readyEntry = latestEntry;
      renderReady(latestEntry);
      el.headlineText.textContent = "会計内容を確保しました。";
      el.bodyText.textContent = "店舗・金額・会計番号をもう一度確認してから、支払い画面へ進んでください。";
      el.openInvoiceBtn.textContent = "確認して支払い画面へ";
      announce("会計内容を確保しました。もう一度確認して支払い画面へ進んでください。");
      return;
    }
    const consumed = await consumeCheckoutClaim(latestEntry, state.claim);
    const destination = new URL(consumed.pay_url, window.location.origin);
    if (!isExpectedPayDestination(destination)) {
      throw terminalEntryError("PAY_DESTINATION_INVALID");
    }
    state.opening = true;
    stopPolling();
    setBadge("移動中", "s-green");
    el.headlineText.textContent = "確認した会計を開いています。";
    el.bodyText.textContent = "この後は会計ごとの請求ページに固定されます。";
    announce("確認した会計を開いています。");
    window.location.replace(destination.href);
  } catch (error) {
    state.opening = false;
    clearReadyState();
    setBadge("再確認が必要", "s-yellow");
    el.headlineText.textContent = "会計ページを開けませんでした。";
    el.bodyText.textContent = customerFacingTerminalError(error, "ENTRY_CONSUME_FAILED");
    announce("会計ページを開けませんでした。会計状態を更新してください。");
    startPolling();
  } finally {
    state.refreshInFlight = false;
    if (!state.opening) {
      el.refreshEntryBtn.disabled = false;
      el.openInvoiceBtn.disabled = !state.readyEntry?.pay_url;
    }
  }
}

el.openInvoiceBtn.addEventListener("click", () => void handleOpenInvoice());
el.refreshEntryBtn.addEventListener("click", () => void refreshEntryState());
window.addEventListener("beforeunload", () => {
  stopPolling();
  if (state.requestController) state.requestController.abort();
});

void refreshEntryState();
