import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

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
  assert.match(gate, /state\.lastRefreshSucceeded/);
  assert.match(gate, /state\.refreshInProgress/);
  assert.match(gate, /lastRefreshInvoiceId/);
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
  for (const id of ["walletPayBtn", "copyInfoBtn", "showMethodsBtn", "copyAddressBtn", "copyAmountBtn", "copyInvoiceBtn"]) {
    assert.match(mobileHtml, new RegExp(`id="${id}"[^>]*disabled`), `${id} must be disabled before JS validation`);
  }
});

test("wallet launch revalidates immediately and prevents rapid duplicate launch", () => {
  const mobileJs = read("public/mobile.js");
  const handler = between(mobileJs, "async function handleWalletPay", "function announceConsentRequired");

  assert.match(handler, /applyPaymentActionGate\(\)/);
  assert.match(handler, /await loadInvoice\(\{ silent: true, force: true \}\)/);
  assert.match(handler, /setLaunchInProgress\(true\)/);
  assert.ok(handler.indexOf("await loadInvoice") < handler.indexOf("location.href"));
  const launchState = between(mobileJs, "function setLaunchInProgress", "async function handleWalletPay");
  assert.doesNotMatch(launchState, /setTimeout/);
  assert.match(launchState, /async function refreshAfterBrowserRecovery/);
  assert.match(mobileJs, /visibilityState === "visible"\) void refreshAfterBrowserRecovery\(\)/);
  assert.match(mobileJs, /setLaunchInProgress\(false\);\s*void loadInvoice\(\{ silent: false, force: true \}\)/);
  for (const functionName of ["handleCopyInfo", "handleCopyAddress", "handleCopyAmount", "handleCopyInvoice", "handleShowMethods"]) {
    const marker = functionName === "handleShowMethods" ? `function ${functionName}` : `async function ${functionName}`;
    const start = mobileJs.indexOf(marker);
    assert.notEqual(start, -1, `${functionName} is missing`);
    assert.match(mobileJs.slice(start, start + 520), /getFreshPayableInvoiceForAction\(\)/, `${functionName} must refresh immediately before exposing payment data`);
  }
});

test("payment detail validation rejects missing or mismatched transfer fields", () => {
  const mobileJs = read("public/mobile.js");
  const source = between(mobileJs, "function validatePaymentDetails", "function evaluatePaymentActionGate");
  const context = vm.createContext({ URL });
  vm.runInContext(`${source}\nglobalThis.validatePaymentDetails = validatePaymentDetails;`, context);
  const validatePaymentDetails = context.validatePaymentDetails;
  const token = "0x1111111111111111111111111111111111111111";
  const recipient = "0x2222222222222222222222222222222222222222";
  const valid = {
    chain_id: "137",
    token_contract: token,
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
});

test("policy and consent recording gates fail closed until server persistence succeeds", () => {
  const mobileJs = read("public/mobile.js");
  const mobileHtml = read("public/mobile.html");
  const recordConsent = between(mobileJs, "async function recordConsent", "function renderConsentRecordState");

  assert.match(recordConsent, /if \(!response\.ok\)/);
  assert.match(recordConsent, /!state\.consented \|\| !el\.consentCheckbox\?\.checked/);
  assert.match(recordConsent, /signal: controller\.signal/);
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

test("paid receipt requires server transaction hash and confirmation time", () => {
  const mobileJs = read("public/mobile.js");
  const mobileHtml = read("public/mobile.html");
  const receipt = between(mobileJs, "function getReceiptEvidence", "function renderStatus");

  assert.match(receipt, /invoice\?\.paid_tx_hash/);
  assert.match(receipt, /invoice\?\.chain_recorded_at/);
  assert.match(receipt, /invoice\?\.confirmed_at/);
  assert.match(receipt, /complete: Boolean\(txHash\) && Number\.isFinite\(confirmedAtMs\)/);
  assert.match(receipt, /evidence\.complete \? "\u304a\u652f\u6255\u3044\u78ba\u8a8d\u66f8" : "\u304a\u652f\u6255\u3044\u72b6\u6cc1\u30e1\u30e2"/);
  assert.match(mobileJs, /`\u30b3\u30d4\u30fc\u65e5\u6642: \$\{copyTimestamp\}`/);
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
  const launchTarget = between(mobileJs, "function buildWalletLaunchTarget", "function buildManualPaymentInstructions");

  assert.match(mobileJs, /WALLET_LAUNCH_PROTOCOLS\s*=\s*new Set/);
  assert.match(launchTarget, /WALLET_LAUNCH_PROTOCOLS\.has\(parsed\.protocol\)/);
  assert.match(launchTarget, /!parsed\.username && !parsed\.password/);
  assert.ok(launchTarget.indexOf('{ type: "payment_uri"') < launchTarget.indexOf('{ type: "wallet_deeplink"'), "validated EIP-681 target must be preferred");
  assert.doesNotMatch(launchTarget, /return \{ type: candidate\.type, url: candidate\.url\.trim\(\) \}/);
  assert.match(mobileJs, /parsed\.protocol === "https:" \|\| parsed\.origin === window\.location\.origin/);
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
