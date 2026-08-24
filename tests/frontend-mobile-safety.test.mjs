import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { READ_ONLY_RECOVERY_CHAIN_IDS } from "../src/payment-recovery.mjs";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("mobile payment actions share one fail-closed gate", () => {
  const mobileJs = read("public/mobile.js");
  const mobileHtml = read("public/mobile.html");
  const gate = between(mobileJs, "function evaluatePaymentActionGate", "function startPolling");

  assert.match(mobileJs, /PAYMENT_ACTION_STATUSES\s*=\s*new Set\(\["issued", "open"\]\)/);
  assert.match(gate, /hasFreshInvoiceObservation\(invoice\)/);
  assert.match(gate, /state\.refreshInProgress/);
  assert.match(mobileJs, /lastRefreshInvoiceId/);
  assert.match(gate, /remainingSeconds\(invoice\.expires_at\)/);
  assert.match(gate, /customerMode\.mode !== "wallet_qr"/);
  assert.match(gate, /validatePaymentDetails\(invoice\)/);
  assert.match(gate, /!state\.consented/);
  assert.match(gate, /!policyLinksReady\(\)/);
  assert.match(gate, /state\.consentRecordStatus !== "recorded"/);
  assert.match(gate, /state\.launchInProgress/);
  assert.match(gate, /unknown_status/);
  assert.match(gate, /expiry_unknown/);
  assert.match(gate, /expired/);
  assert.match(gate, /el\.walletPayBtn, el\.showMethodsBtn, el\.copyInfoBtn/);
  assert.match(gate, /el\.copyAddressBtn\.disabled\s*=\s*!walletAllowed/);
  assert.match(gate, /el\.copyAmountBtn\.disabled\s*=\s*!walletAllowed/);
  assert.match(gate, /el\.copyInvoiceBtn\.disabled\s*=\s*!walletAllowed/);
  assert.match(gate, /el\.copyTokenContractBtn\.disabled\s*=\s*!walletAllowed/);
  for (const id of ["walletPayBtn", "copyInfoBtn", "showMethodsBtn", "copyAddressBtn", "copyTokenContractBtn", "copyAmountBtn", "copyInvoiceBtn"]) {
    assert.match(mobileHtml, new RegExp(`id="${id}"[^>]*disabled`), `${id} must be disabled before JS validation`);
  }
});

test("wallet launch revalidates immediately and uses one launch method per tap", () => {
  const mobileJs = read("public/mobile.js");
  const handler = between(mobileJs, "async function handleWalletPay", "function announceConsentRequired");

  assert.match(handler, /applyPaymentActionGate\(\)/);
  assert.match(handler, /await loadInvoice\(\{ silent: true, force: true \}\)/);
  assert.match(handler, /setLaunchInProgress\(true\)/);
  assert.ok(handler.indexOf("await loadInvoice") < handler.indexOf("launchWalletOnce"));
  const launchState = between(mobileJs, "function setLaunchInProgress", "function launchWalletOnce");
  assert.doesNotMatch(launchState, /setTimeout/);
  const launchOnce = between(mobileJs, "function launchWalletOnce", "async function refreshAfterBrowserRecovery");
  assert.match(launchOnce, /const candidate = buildWalletLaunchTarget\(invoice\)/);
  assert.equal((launchOnce.match(/location\.href\s*=/g) || []).length, 1);
  assert.doesNotMatch(launchOnce, /attempt\s*\(|candidate\s*=\s*candidates\[/);
  assert.match(launchOnce, /自動で別のアプリを起動しません/);
  assert.match(launchOnce, /支払い情報をコピー/);
  assert.match(launchOnce, /WALLET_RECOVERY_DELAY_MS/);
  assert.match(mobileJs, /async function refreshAfterBrowserRecovery/);
  assert.match(mobileJs, /visibilityState === "visible"\) void refreshAfterBrowserRecovery\(\)/);
  assert.match(mobileJs, /setLaunchInProgress\(false\);\s*void loadInvoice\(\{ silent: false, force: true \}\)/);
  for (const functionName of ["handleCopyInfo", "handleCopyAddress", "handleCopyTokenContract", "handleCopyAmount", "handleCopyInvoice", "handleShowMethods"]) {
    const marker = functionName === "handleShowMethods" ? `function ${functionName}` : `async function ${functionName}`;
    const start = mobileJs.indexOf(marker);
    assert.notEqual(start, -1, `${functionName} is missing`);
    assert.match(mobileJs.slice(start, start + 520), /getFreshPayableInvoiceForAction\(\)/, `${functionName} must refresh immediately before exposing payment data`);
  }
});

test("payment detail validation rejects missing or mismatched transfer fields", () => {
  const mobileJs = read("public/mobile.js");
  const officialContractSource = between(mobileJs, "function getOfficialTokenContract", "function getNetwork");
  const source = between(mobileJs, "function validatePaymentDetails", "function evaluatePaymentActionGate");
  const context = vm.createContext({ URL });
  vm.runInContext(`${officialContractSource}\n${source}\nglobalThis.validatePaymentDetails = validatePaymentDetails;`, context);
  const validatePaymentDetails = context.validatePaymentDetails;
  const token = "0x1111111111111111111111111111111111111111";
  const recipient = "0x2222222222222222222222222222222222222222";
  const valid = {
    chain_id: "137",
    token_contract: token,
    official_token_contract: token,
    receive_address: recipient,
    recipient_address: recipient,
    amount_jpyc: 1000,
    amount_jpyc_base: "1000000000",
    expected_amount_atomic: "1000000000",
    token_decimals: 6,
    copy_fallback: { copy_receive_address: recipient, copy_amount: "1000000000" },
    payment_uri: `ethereum:${token}@137/transfer?address=${recipient}&uint256=1000000000`,
  };

  assert.equal(validatePaymentDetails(valid).ok, true);
  for (const mutation of [
    { chain_id: "" },
    { token_contract: "" },
    { official_token_contract: "" },
    { official_token_contract: "0x3333333333333333333333333333333333333333" },
    { receive_address: "" },
    { recipient_address: "0x3333333333333333333333333333333333333333" },
    { amount_jpyc: 0 },
    { amount_jpyc_base: "not-an-integer" },
    { expected_amount_atomic: "0" },
    { token_decimals: null },
    { copy_fallback: { copy_receive_address: recipient, copy_amount: "999" } },
    { payment_uri: `ethereum:${token}@1/transfer?address=${recipient}&uint256=1000000000` },
    { payment_uri: `ethereum:${token}@137/transfer?address=${recipient}&uint256=1000000000&redirect=https://attacker.invalid` },
  ]) {
    assert.equal(validatePaymentDetails({ ...valid, ...mutation }).ok, false, JSON.stringify(mutation));
  }
});

test("invoice refresh rejects stale responses and refreshes on browser recovery events", () => {
  const mobileJs = read("public/mobile.js");

  assert.match(mobileJs, /new AbortController\(\)/);
  assert.match(mobileJs, /state\.refreshController\.abort\(\)/);
  assert.match(mobileJs, /requestSequence !== state\.refreshSequence/);
  assert.match(mobileJs, /signal: controller\.signal/);
  assert.match(mobileJs, /cache: "no-store"/);
  assert.match(mobileJs, /response\?\.headers\?\.get\?\.\("date"\)/);
  assert.match(mobileJs, /updateServerClock\(response, requestStartedAtMs, data\.server_now\)/);
  assert.match(mobileJs, /addEventListener\("pageshow"/);
  assert.match(mobileJs, /addEventListener\("visibilitychange"/);
  assert.match(mobileJs, /document\.visibilityState === "visible"/);
  assert.match(mobileJs, /addEventListener\("online"/);
  assert.match(mobileJs, /setBlockingWarning\("\u8acb\u6c42\u306e\u6700\u65b0\u72b6\u614b\u3092\u78ba\u8a8d\u3067\u304d\u306a\u3044\u305f\u3081/);
  assert.match(mobileJs, /closeErrorBannerBtn\.classList\.toggle\("hidden", Boolean\(state\.blockingWarning\)\)/);
  assert.match(mobileJs, /function failClosedInvoiceObservation/);
  assert.match(mobileJs, /function scheduleObservationFreshnessHold/);
  assert.match(mobileJs, /renderCustomerAction\(state\.invoice\)/);
  assert.match(mobileJs, /renderReceiptCard\(state\.invoice\)/);
  assert.match(mobileJs, /renderStatus\(state\.invoice\)/);
  assert.match(mobileJs, /state\.observationFreshnessTimer = setTimeout/);
  assert.match(mobileJs, /MOBILE_REQUEST_TIMEOUT_MS\s*=\s*10_000/);
  assert.match(mobileJs, /INITIAL_RETRY_DELAYS_MS\s*=\s*Object\.freeze\(\[1_000, 2_000, 4_000\]\)/);
  assert.match(mobileJs, /requestTimedOut = true;\s*controller\.abort\(\)/);
  assert.match(mobileJs, /automaticRetryCount >= INITIAL_RETRY_DELAYS_MS\.length/);
  assert.match(mobileJs, /自動再試行に失敗しました/);
  assert.match(mobileJs, /retryLoadBtn\.addEventListener\("click"/);
  assert.match(read("public/mobile.html"), /id="retryLoadBtn"[^>]*>請求を再取得/);
});

test("payment recovery renders only server-supplied chains and stays disabled without that contract", () => {
  const mobileJs = read("public/mobile.js");
  const mobileHtml = read("public/mobile.html");
  const source = between(mobileJs, "function normalizeRecoveryChains", "function renderPaymentRecovery");
  const makeSelect = () => ({
    value: "",
    disabled: false,
    children: [],
    replaceChildren() { this.children = []; },
    appendChild(node) { this.children.push(node); },
  });
  const el = { recoveryChainId: makeSelect() };
  const context = vm.createContext({
    state: { recoveryChains: [], recoverySubmitting: false },
    el,
    document: { createElement: () => ({ value: "", textContent: "" }) },
  });
  vm.runInContext(
    `${source}\nthis.normalizeForTest = normalizeRecoveryChains; this.syncForTest = syncRecoveryChainOptions;`,
    context,
  );

  context.syncForTest({});
  assert.equal(el.recoveryChainId.disabled, true);
  assert.deepEqual(Array.from(el.recoveryChainId.children, (option) => option.value), [""]);
  assert.match(el.recoveryChainId.children[0].textContent, /確認できません/);

  context.syncForTest({
    payment_recovery_chains: [
      { chain_id: "137", network: "Polygon" },
      { chain_id: "43114", network: "Avalanche" },
      { chain_id: "137", network: "重複" },
      { chain_id: "not-a-chain", network: "不正" },
    ],
  });
  assert.equal(el.recoveryChainId.disabled, false);
  assert.deepEqual(
    Array.from(el.recoveryChainId.children, (option) => option.value),
    ["", "137", "43114"],
  );
  assert.match(el.recoveryChainId.children[1].textContent, /Polygon.*137/);
  assert.equal(el.recoveryChainId.children.some((option) => option.value === "1"), false);
  assert.match(mobileHtml, /id="recoveryChainId"[^>]*disabled/);
  assert.match(mobileHtml, /id="submitRecoveryBtn"[^>]*disabled/);

  const submit = between(mobileJs, "async function submitPaymentRecovery", "async function refreshAfterBrowserRecovery");
  assert.match(submit, /state\.recoveryChains\.some/);
  assert.doesNotMatch(submit, /\["1",\s*"43114"(?:,\s*"137")?\]\.includes/);
  assert.match(submit, /chain_id:\s*chainId/);
  assert.ok(READ_ONLY_RECOVERY_CHAIN_IDS.includes("137"), "canonical recovery policy must include Polygon 137");
});

test("mobile observation age and failures remove stale completion state", () => {
  const mobileJs = read("public/mobile.js");
  const source = between(mobileJs, "function hasFreshInvoiceObservation", "function hasIntegrityHold");
  const now = Date.now();
  const context = vm.createContext({
    OBSERVATION_FRESHNESS_MS: 30_000,
    state: {
      lastRefreshSucceeded: true,
      lastRefreshInvoiceId: "invoice-1",
      lastRefreshAtMs: now - 1_000,
    },
  });
  vm.runInContext(`${source}\nglobalThis.hasFreshInvoiceObservation = hasFreshInvoiceObservation;`, context);
  const invoice = { invoice_id: "invoice-1" };
  assert.equal(context.hasFreshInvoiceObservation(invoice), true);
  context.state.lastRefreshSucceeded = false;
  assert.equal(context.hasFreshInvoiceObservation(invoice), false);
  context.state.lastRefreshSucceeded = true;
  context.state.lastRefreshAtMs = now - 30_001;
  assert.equal(context.hasFreshInvoiceObservation(invoice), false);

  const receiptHandler = between(mobileJs, "async function handleCopyReceipt", "async function loadInvoice");
  assert.match(receiptHandler, /hasIntegrityHold\(invoice\)/);
  assert.match(receiptHandler, /!hasFreshInvoiceObservation\(invoice\)/);
  assert.match(receiptHandler, /!\["paid", "settled"\]\.includes\(status\)/);
});

test("official token contract is server-sourced, fully wrapped, and copied through the fresh payment gate", () => {
  const mobileJs = read("public/mobile.js");
  const mobileHtml = read("public/mobile.html");
  const css = read("public/app.css");
  const server = read("src/server.mjs");

  assert.match(server, /official_token_contract:\s*officialPaymentChain\?\.token_contract\s*\|\|\s*null/);
  assert.match(mobileHtml, /id="tokenContractText"[^>]*contract-address-text/);
  assert.match(mobileHtml, /id="copyTokenContractBtn"[^>]*disabled/);
  assert.match(mobileJs, /tokenContractText\.textContent = tokenContract \|\| "-"/);
  assert.match(mobileJs, /async function handleCopyTokenContract/);
  assert.match(mobileJs, /copyTokenContractBtn\.addEventListener\("click"/);
  assert.match(mobileJs, /await copyText\(getOfficialTokenContract\(invoice\)\)/);
  assert.match(mobileJs, /`公式JPYCコントラクト: \$\{getOfficialTokenContract\(invoice\) \|\| "-"\}`/);
  assert.match(css, /\.contract-address-text\s*\{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-all;/);
  assert.doesNotMatch(mobileJs, /0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29/i);
});

test("policy and consent recording gates fail closed until server persistence succeeds", () => {
  const mobileJs = read("public/mobile.js");
  const mobileHtml = read("public/mobile.html");
  const recordConsent = between(mobileJs, "async function recordConsent", "function renderConsentRecordState");

  assert.match(recordConsent, /if \(!response\.ok\)/);
  assert.match(recordConsent, /!state\.consented \|\| !el\.consentCheckbox\?\.checked/);
  assert.match(recordConsent, /signal: controller\.signal/);
  assert.match(recordConsent, /MOBILE_REQUEST_TIMEOUT_MS/);
  assert.match(recordConsent, /timedOut = true/);
  assert.match(recordConsent, /CONSENT_RECORD_TIMEOUT/);
  assert.match(recordConsent, /clearTimeout\(timeoutId\)/);
  assert.match(recordConsent, /consentSequence !== state\.consentSequence/);
  assert.match(recordConsent, /consentRecordStatus = "failed"/);
  assert.match(recordConsent, /return false/);
  assert.match(recordConsent, /applyPaymentActionGate\(state\.invoice\)/);
  assert.match(recordConsent, /state\.lastRefreshSucceeded = false/);
  assert.match(recordConsent, /await loadInvoice\(\{ silent: true, force: true \}\)/);
  assert.match(mobileJs, /function isPublishedPolicyUrl/);
  assert.match(mobileJs, /function isPublicPolicyHostname/);
  assert.match(mobileJs, /!parsed\.username/);
  assert.match(mobileJs, /draft\|pending\|placeholder\|example/);
  assert.doesNotMatch(mobileJs, /POLICY_URLS\.terms \|\| "#"/);
  assert.match(mobileJs, /retryConsentBtn\.addEventListener\("click", \(\) => void recordConsent\(\)\)/);
  assert.match(mobileHtml, /id="consentRecordError"[^>]*role="alert"/);
  assert.match(mobileHtml, /id="retryConsentBtn"/);
  assert.match(mobileHtml, /id="consentCheckbox"[^>]*aria-describedby="consentRequirementHint"/);
});

test("customer and review risk badges expose semantic status tones", () => {
  const mobileJs = read("public/mobile.js");
  const mobileHtml = read("public/mobile.html");
  const terminalJs = read("public/terminal.js");
  const terminalHtml = read("public/terminal.html");
  const customerAction = between(mobileJs, "function renderCustomerAction", "function updateRemainingAnnouncement");

  assert.match(mobileHtml, /id="customerActionBadge" class="status-pill s-gray"/);
  assert.match(mobileJs, /function setCustomerActionBadge\(label, tone = "s-gray"\)/);
  for (const tone of ["s-blue", "s-green", "s-yellow", "s-red"]) {
    assert.match(customerAction, new RegExp(`tone: "${tone}"`));
  }
  assert.match(customerAction, /setCustomerActionBadge\(verified \? "要確認" : "申告受付済み", verified \? "s-red" : "s-yellow"\)/);
  assert.match(customerAction, /setCustomerActionBadge\("要確認", "s-red"\)/);
  assert.match(terminalHtml, /id="reviewDetailBadge" class="status-pill s-gray"/);
  assert.match(terminalJs, /review\.status === "resolved" \? "s-green" : review\.status === "rejected" \? "s-red" : priority\.className/);
});

test("published policy URLs reject local, reserved, credentialed, and IP-literal destinations", () => {
  const mobileJs = read("public/mobile.js");
  const source = between(mobileJs, "function isPublicPolicyHostname", "function policyLinksReady");
  const context = vm.createContext({ URL });
  vm.runInContext(`${source}\nglobalThis.isPublishedPolicyUrl = isPublishedPolicyUrl;`, context);
  const isPublishedPolicyUrl = context.isPublishedPolicyUrl;

  assert.equal(isPublishedPolicyUrl("https://legal.jpyc.jp/terms/v1"), true);
  for (const candidate of [
    "http://legal.jpyc.jp/terms/v1",
    "https://user:secret@legal.jpyc.jp/terms/v1",
    "https://localhost/terms",
    "https://localhost./terms",
    "https://localhost../terms",
    "https://service.localhost/terms",
    "https://127.0.0.1/terms",
    "https://10.0.0.1/terms",
    "https://[::1]/terms",
    "https://intranet/terms",
    "https://example.com/terms",
    "https://legal.example.net/terms",
    "https://legal.test/terms",
    "https://legal.invalid/terms",
    "https://legal.local/terms",
    "https://legal.home.arpa/terms",
  ]) {
    assert.equal(isPublishedPolicyUrl(candidate), false, candidate);
  }
});

test("paid confirmation keeps complete evidence requirements while hiding internal signing fields", async () => {
  const mobileJs = read("public/mobile.js");
  const mobileHtml = read("public/mobile.html");
  const receiptSource = between(mobileJs, "function getReceiptEvidence", "function renderStatus");
  const copySource = between(mobileJs, "async function handleCopyReceipt", "async function loadInvoice");
  const makeClassList = () => ({
    hidden: false,
    toggle(_name, force) { this.hidden = Boolean(force); },
  });
  const makeElement = () => ({
    textContent: "",
    className: "",
    disabled: false,
    classList: makeClassList(),
    setAttribute(name, value) { this[name] = value; },
  });
  const el = {
    receiptCard: makeElement(),
    copyReceiptBtn: makeElement(),
    receiptTitle: makeElement(),
    receiptStatusBadge: makeElement(),
    receiptStoreName: makeElement(),
    receiptAmount: makeElement(),
    receiptInvoiceId: makeElement(),
    receiptTxHash: makeElement(),
    receiptChainRecordedAt: makeElement(),
    receiptConfirmedAt: makeElement(),
    receiptEvidenceNotice: makeElement(),
  };
  let copiedText = "";
  let announced = "";
  const context = vm.createContext({
    state: { invoice: null },
    el,
    Date,
    Number,
    String,
    canonicalInvoiceStatus: (value) => value,
    hasIntegrityHold: () => false,
    hasFreshInvoiceObservation: () => true,
    formatDateTime: (value) => `日時:${value}`,
    formatJpy: (value) => `JPY:${value}`,
    toNumber: Number,
    getTokenSymbol: () => "JPYC",
    copyText: async (value) => { copiedText = value; },
    announce: (value) => { announced = value; },
    showError: (error) => { throw new Error(String(error)); },
    customerFacingError: (error) => String(error),
  });
  vm.runInContext(
    `${receiptSource}\n${copySource}\nthis.evidenceForTest = getReceiptEvidence; this.renderForTest = renderReceiptCard; this.copyForTest = handleCopyReceipt;`,
    context,
  );
  const completeInvoice = {
    status: "paid",
    store_name: "テスト店舗",
    amount_jpy: 1250,
    amount_jpyc: 1250,
    invoice_id: "invoice-1",
    paid_tx_hash: `0x${"a".repeat(64)}`,
    chain_recorded_at: "2026-08-13T00:00:00.000Z",
    confirmed_at: "2026-08-13T00:00:01.000Z",
    receipt: {
      signature: "private-signature-material",
      kid: "internal-key-id",
      content_sha256: "internal-content-hash",
      tx_hash: `0x${"a".repeat(64)}`,
    },
  };

  assert.equal(context.evidenceForTest(completeInvoice).complete, true);
  for (const missingField of ["signature", "kid", "content_sha256", "tx_hash"]) {
    const invoice = { ...completeInvoice, receipt: { ...completeInvoice.receipt, [missingField]: "" } };
    assert.equal(context.evidenceForTest(invoice).complete, false, `${missingField} is required internally`);
  }
  assert.equal(context.evidenceForTest({ ...completeInvoice, confirmed_at: "" }).complete, false);

  context.renderForTest(completeInvoice);
  assert.equal(el.receiptTitle.textContent, "お支払い確認情報");
  assert.equal(el.receiptStatusBadge.textContent, "支払い確認済み");
  for (const internalTerm of ["receipt", "kid", "signature", "sha256", "internal-key-id"]) {
    assert.equal(el.receiptEvidenceNotice.textContent.includes(internalTerm), false, internalTerm);
  }

  context.state.invoice = completeInvoice;
  await context.copyForTest();
  assert.match(copiedText, /お支払い確認情報/);
  assert.match(copiedText, /取引番号/);
  assert.match(copiedText, /サーバー確認日時/);
  for (const internalTerm of ["receipt_version", "receipt_content_sha256", "receipt_signature", "receipt_kid", "private-signature-material", "internal-key-id", "internal-content-hash"]) {
    assert.equal(copiedText.includes(internalTerm), false, internalTerm);
  }
  assert.match(announced, /確認情報をコピーしました/);
  assert.match(mobileHtml, /id="receiptConfirmedAt"/);
  assert.match(mobileHtml, /id="receiptChainRecordedAt"/);
  assert.match(mobileHtml, /id="receiptEvidenceNotice"[^>]*aria-live="polite"/);
  assert.ok(
    mobileHtml.indexOf('id="receiptCard"') < mobileHtml.indexOf('id="paymentActionTitle"'),
    "paid receipt should appear before the long payment guide"
  );
});

test("wallet and help navigation reject unsafe URL schemes", () => {
  const mobileJs = read("public/mobile.js");
  const launchTarget = between(mobileJs, "function buildWalletLaunchCandidates", "function buildWalletLaunchTarget");

  assert.match(mobileJs, /WALLET_LAUNCH_PROTOCOLS\s*=\s*new Set/);
  assert.match(launchTarget, /adapter\.available !== true \|\| adapter\.status !== "ready"/);
  assert.match(launchTarget, /WALLET_LAUNCH_PROTOCOLS\.has\(parsed\.protocol\)/);
  assert.match(launchTarget, /!parsed\.username && !parsed\.password/);
  assert.ok(launchTarget.indexOf('{ type: "wallet_deeplink"') < launchTarget.indexOf('{ type: "wallet_url"'), "reviewed wallet deeplink must be preferred");
  assert.ok(launchTarget.indexOf('{ type: "wallet_deeplink"') < launchTarget.indexOf('{ type: "payment_uri"'), "reviewed wallet deeplink must precede the standard URI");
  assert.ok(launchTarget.indexOf('{ type: "payment_uri"') < launchTarget.indexOf('{ type: "wallet_url"'), "standard payment URI must precede the generic wallet URL fallback");
  assert.match(launchTarget, /const seenUrls = new Set\(\)/);
  assert.doesNotMatch(launchTarget, /return \{ type: candidate\.type, url: candidate\.url\.trim\(\) \}/);
  assert.match(mobileJs, /parsed\.protocol === "https:" \|\| parsed\.origin === window\.location\.origin/);
});

test("wallet support labels remain capability-scoped instead of claiming broad support", () => {
  const mobileJs = read("public/mobile.js");
  assert.match(mobileJs, /WALLET_SCOPED_CAPABILITY_PREFIX/);
  assert.match(mobileJs, /WALLET_BROAD_TESTED_PREFIX/);
  assert.match(mobileJs, /未検証（検証OS・バージョン不明）/);
  assert.match(mobileJs, /未検証: \$\{value\}/);
  assert.match(mobileJs, /手動送金のみ: 支払い情報コピー/);
  assert.match(mobileJs, /walletSupportTitle\.textContent = "ウォレット起動状況"/);
  assert.match(mobileJs, /この端末の動作保証ではありません/);
});

test("remaining-time announcements are thresholded and compact mobile controls meet 44px", () => {
  const mobileJs = read("public/mobile.js");
  const css = read("public/app.css");

  assert.match(mobileJs, /REMAINING_ANNOUNCEMENT_THRESHOLDS_SEC\s*=\s*\[300, 120, 60, 30, 10, 0\]/);
  assert.match(mobileJs, /threshold === state\.announcedRemainingThreshold/);
  assert.doesNotMatch(mobileJs, /announcedMinute/);
  assert.match(css, /--tap-target-min:\s*44px/);
  assert.match(css, /\.mobile-surface \.btn-compact\s*\{\s*min-height:\s*var\(--tap-target-min\);\s*\}/);
  assert.match(css, /\.mobile-surface \.consent-checkbox-row\s*\{[\s\S]*?min-height:\s*var\(--tap-target-min\)/);
  assert.match(css, /\.btn:disabled\s*\{[\s\S]*?transition:\s*none/);
});
