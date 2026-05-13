const query = new URLSearchParams(location.search);
const terminalToken = query.get("token");
const POLL_INTERVAL_MS = 3000;

const state = {
  pollTimer: null,
  redirecting: false,
};

const el = {
  liveStatus: document.getElementById("liveStatus"),
  entryBadge: document.getElementById("entryBadge"),
  storeText: document.getElementById("storeText"),
  headlineText: document.getElementById("headlineText"),
  bodyText: document.getElementById("bodyText"),
  helpList: document.getElementById("helpList"),
};

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
  stopPolling();
  state.pollTimer = setInterval(() => {
    void refreshEntryState({ silent: true });
  }, POLL_INTERVAL_MS);
}

async function requestEntryState() {
  if (!terminalToken) {
    throw new Error("端末入口QRの情報が見つかりません");
  }
  const response = await fetch(`/api/v1/public/terminal-entry/${encodeURIComponent(terminalToken)}`, {
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || "会計状態の取得に失敗しました";
    throw new Error(message);
  }
  return payload;
}

function renderWaiting(entry) {
  setBadge("会計準備中", "s-blue");
  el.storeText.textContent = entry.store_name || "-";
  el.headlineText.textContent = "店舗側で会計を準備しています。";
  el.bodyText.textContent = "準備ができると、この端末入口QRからその時点の請求ページへ自動で移動します。";
  setHelp([
    "お支払い画面が表示されるまで、この画面のままお待ちください。",
    "会計がまだ立っていないため、支払い先や金額は表示されていません。",
    "長く進まない場合は、店舗スタッフへお声がけください。",
  ]);
  announce("会計準備中です。");
}

function renderBlocked(entry) {
  setBadge("要スタッフ確認", "s-yellow");
  el.storeText.textContent = entry.store_name || "-";
  el.headlineText.textContent = "会計状態を確認中です。";
  el.bodyText.textContent = "この端末で複数の active invoice が検出されたため、自動で請求を選択していません。";
  setHelp([
    "店舗スタッフが会計状態を確認するまでお待ちください。",
    "この画面から秘密鍵やシードフレーズを入力することはありません。",
  ]);
  announce("店舗スタッフによる確認が必要です。");
}

function renderTapPresented(entry) {
  setBadge("店頭案内中", "s-blue");
  el.storeText.textContent = entry.store_name || "-";
  el.headlineText.textContent = entry.customer_payment_mode?.title || "店頭端末でお支払いをご案内しています。";
  el.bodyText.textContent =
    entry.customer_payment_mode?.body || entry.message || "この会計は端末入口QRからのウォレット導線を一時停止しています。";
  setHelp([
    "カード・スマホをお使いの場合は、店舗スタッフの案内に従ってください。",
    "この端末入口QRから別の支払い方法へ切り替えることはできません。",
    "長く進まない場合は、店舗スタッフへお声がけください。",
  ]);
  announce("店頭端末でお支払いをご案内しています。");
}

function redirectToInvoice(entry) {
  if (state.redirecting || !entry.pay_url) return;
  state.redirecting = true;
  stopPolling();
  setBadge("移動中", "s-green");
  el.storeText.textContent = entry.store_name || "-";
  el.headlineText.textContent = "請求ページへ移動しています。";
  el.bodyText.textContent = "この後は会計ごとの請求ページに固定されます。";
  announce("請求ページへ移動しています。");
  window.location.replace(entry.pay_url);
}

async function refreshEntryState({ silent = false } = {}) {
  try {
    const entry = await requestEntryState();
    if (entry.status === "ready") {
      redirectToInvoice(entry);
      return;
    }
    if (entry.status === "blocked") {
      renderBlocked(entry);
      stopPolling();
      return;
    }
    if (entry.status === "tap_presented") {
      renderTapPresented(entry);
      startPolling();
      return;
    }
    renderWaiting(entry);
    startPolling();
  } catch (error) {
    setBadge("再確認中", "s-yellow");
    el.storeText.textContent = "-";
    el.headlineText.textContent = "会計状態を再確認しています。";
    el.bodyText.textContent = String(error.message || error);
    if (!silent) {
      setHelp([
        "通信状態を確認しています。この画面のまま少しお待ちください。",
        "長く進まない場合は、店舗スタッフへお声がけください。",
      ]);
    }
    announce("会計状態を再確認しています。");
    startPolling();
  }
}

void refreshEntryState();
