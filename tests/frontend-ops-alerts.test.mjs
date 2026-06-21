import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

// P0-UX-01: Supported wallet card is shown before payment without the old warning list.
test("P0-UX-01 mobile shows supported wallet card before payment without warning copy", () => {
  const mobileHtml = read("public/mobile.html");
  const mobileJs = read("public/mobile.js");
  const paymentCard = mobileHtml.match(/<section id="paymentConditionsCard"[\s\S]*?<\/section>/)?.[0] || "";

  assert.match(mobileHtml, /id="paymentConditionsCard"/);
  assert.match(paymentCard, />対応ウォレット</);
  assert.match(paymentCard, /id="supportedWalletChips"/);
  assert.doesNotMatch(paymentCard, /id="paymentConditionsList"/);
  assert.doesNotMatch(paymentCard, /送金は1回/);
  assert.doesNotMatch(paymentCard, /MATIC/);

  assert.match(mobileJs, /renderPaymentConditions/);
  assert.match(mobileJs, /paymentConditionsCard/);
  assert.match(mobileJs, /WAITING_STATUSES/);
  assert.doesNotMatch(mobileJs, /送金は1回だけ。金額と送金先を確認してください。/);
  assert.doesNotMatch(mobileJs, /MATIC残高が不足すると送金できません。/);
});

// P0-UX-02: Payment confirmation card shown after payment with tx hash and save button
test("P0-UX-02 mobile shows payment confirmation card after payment with all fields and save button", () => {
  const mobileHtml = read("public/mobile.html");
  const mobileJs = read("public/mobile.js");

  assert.match(mobileHtml, /id="receiptCard"/);
  assert.match(mobileHtml, /id="receiptView"/);
  assert.match(mobileHtml, /追加の送金は不要です/);
  assert.match(mobileHtml, /id="showStaffBtn"/);
  assert.match(mobileHtml, /店舗スタッフに見せる/);
  assert.match(mobileHtml, /id="copyReceiptInvoiceBtn"/);
  assert.match(mobileHtml, /id="copyReceiptTxBtn"/);
  assert.match(mobileHtml, /id="receiptTransactionDetails"/);
  assert.match(mobileHtml, /id="receiptPolicyDetails"/);
  assert.match(mobileHtml, /返金・紛争はご利用店舗の窓口へお問い合わせください。/);
  assert.doesNotMatch(mobileHtml, /返金や送金は店舗側で別途確認されます。この画面は支払い確認の表示です。/);
  assert.match(mobileHtml, /id="receiptSupportDetails"/);
  assert.match(mobileHtml, /id="receiptStoreName"/);
  assert.match(mobileHtml, /id="receiptAmount"/);
  assert.match(mobileHtml, /id="receiptInvoiceId"/);
  assert.match(mobileHtml, /id="receiptTxHash"/);
  assert.match(mobileHtml, /id="downloadReceiptBtn"/);
  assert.match(mobileHtml, /支払い確認書を保存/);
  assert.match(mobileHtml, /税務上の領収書または適格請求書ではありません/);
  assert.match(mobileHtml, /お支払い確認書/);

  assert.match(mobileJs, /renderReceiptCard/);
  assert.match(mobileJs, /receiptView/);
  assert.match(mobileJs, /mobileSummaryCard[\s\S]*classList\.toggle\("hidden", isPaid\)/);
  assert.match(mobileJs, /mobileDisclosureStack[\s\S]*classList\.toggle\("hidden", isPaid\)/);
  assert.match(mobileJs, /receiptCard/);
  assert.match(mobileJs, /receiptTxHash/);
  assert.match(mobileJs, /downloadReceiptBtn/);
  assert.match(mobileJs, /handleDownloadReceipt/);
  assert.match(mobileJs, /buildReceiptDownloadHtml/);
  assert.match(mobileJs, /receiptFileName/);
  assert.match(mobileJs, /handleCopyReceiptInvoice/);
  assert.match(mobileJs, /handleCopyReceiptTx/);
});

// P0-UX-03: confirming state explicitly warns against double-send
test("P0-UX-03 mobile confirming state warns against double-send", () => {
  const mobileJs = read("public/mobile.js");

  assert.match(mobileJs, /confirming/);
  assert.match(mobileJs, /二重送/);
});

// P0-OPS-01: terminal has address pool threshold and count display
test("P0-OPS-01 terminal has address pool warning threshold and count display", () => {
  const terminalJs = read("public/terminal.js");
  const terminalHtml = read("public/terminal.html");

  assert.match(terminalJs, /ADDRESS_POOL_WARN_THRESHOLD/);
  assert.match(terminalJs, /address_pool_available_count/);
  assert.match(terminalJs, /opsAddressPoolCount/);
  assert.match(terminalHtml, /id="opsAddressPoolCount"/);
  assert.match(terminalHtml, /受取アドレス残数/);
});

// P0-OPS-02: terminal has worker staleness detection
test("P0-OPS-02 terminal has worker staleness detection using worker:last_cycle_at", () => {
  const terminalJs = read("public/terminal.js");
  const terminalHtml = read("public/terminal.html");

  assert.match(terminalJs, /WORKER_STALE_WARN_SEC/);
  assert.match(terminalJs, /worker:last_cycle_at/);
  assert.match(terminalJs, /detectWorkerStaleSec/);
  assert.match(terminalJs, /opsWorkerStatus/);
  assert.match(terminalHtml, /id="opsWorkerStatus"/);
  assert.match(terminalHtml, /状態更新/);
});

// P0-OPS-03: terminal HTML and JS both reference the ops metrics elements
test("P0-OPS-03 terminal HTML and JS are consistent for new ops metric elements", () => {
  const terminalJs = read("public/terminal.js");
  const terminalHtml = read("public/terminal.html");

  assert.match(terminalHtml, /id="opsAddressPoolCount"/);
  assert.match(terminalHtml, /id="opsWorkerStatus"/);
  assert.match(terminalJs, /opsAddressPoolCount/);
  assert.match(terminalJs, /opsWorkerStatus/);
});

// P0-OPS-04: terminal auto-refreshes ops snapshot periodically
test("P0-OPS-04 terminal has startOpsAutoRefresh and stopOpsAutoRefresh wired into lifecycle", () => {
  const terminalJs = read("public/terminal.js");

  assert.match(terminalJs, /startOpsAutoRefresh/);
  assert.match(terminalJs, /stopOpsAutoRefresh/);
  assert.match(terminalJs, /autoRefreshTimer/);
  assert.match(terminalJs, /OPS_AUTO_REFRESH_INTERVAL_MS/);
  assert.match(terminalJs, /setInterval/);
  assert.match(terminalJs, /clearInterval/);
  assert.match(terminalJs, /beforeunload[\s\S]{0,200}stopOpsAutoRefresh/);
});

// P0-OPS-06: review screen responsive CSS (visual regression guard)
test("P0-OPS-06 review workbench has responsive breakpoints and mobile master/detail pattern", () => {
  const terminalHtml = read("public/terminal.html");
  const terminalJs = read("public/terminal.js");
  const appCss = read("public/app.css");

  // CSS: 768px breakpoint collapses workbench to single column
  assert.match(appCss, /@media\s*\(max-width:\s*768px\)/);
  const bp768 = appCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(bp768, /\.review-workbench/);
  assert.match(bp768, /grid-template-columns:\s*1fr/);

  // CSS: 640px breakpoint implements master/detail
  assert.match(appCss, /@media\s*\(max-width:\s*640px\)/);
  assert.match(appCss, /\.review-workbench\s*\.review-detail-pane\s*\{[\s\S]{0,80}display:\s*none/);
  assert.match(appCss, /\.review-workbench\.has-detail-open\s*\.review-list-pane[\s\S]{0,80}display:\s*none/);
  assert.match(appCss, /\.review-workbench\.has-detail-open\s*\.review-detail-pane[\s\S]{0,80}display:\s*grid/);

  // CSS: back button shown only at mobile (hidden in base styles)
  assert.match(appCss, /\.review-mobile-back-btn\s*\{[\s\S]{0,80}display:\s*none/);
  assert.match(appCss, /\.review-mobile-back-btn\s*\{[\s\S]{0,200}display:\s*flex/);

  // CSS: safe-area-inset-bottom used in 640px padding-bottom
  const bp640 = appCss.match(/@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?(?=\n@media)/)?.[0] || "";
  assert.match(bp640, /env\(safe-area-inset-bottom\)/);
  assert.match(bp640, /\.ops-reviews-screen/);

  // HTML: mobile back button present in review detail pane
  assert.match(terminalHtml, /id="reviewMobileBackBtn"/);
  assert.match(terminalHtml, /class="review-mobile-back-btn"/);

  // JS: has-detail-open toggled on card selection and back button handler wired
  assert.match(terminalJs, /has-detail-open/);
  assert.match(terminalJs, /reviewMobileBackBtn/);
  assert.match(terminalJs, /classList\.add\("has-detail-open"\)/);
  assert.match(terminalJs, /classList\.remove\("has-detail-open"\)/);
});

// P0-SEC-CONSENT: server exposes /consent as public policy acknowledgement alias
test("P0-SEC-CONSENT server exposes /consent endpoint as public policy acknowledgement alias", () => {
  const server = read("src/server.mjs");
  assert.match(server, /\/api\/v1\/public\/invoices\/:invoiceId\/consent/);
  assert.match(server, /handlePolicyAcknowledgement/);
});

// P0-OPS-05: server chain-monitor/status includes address_pool_available_count
test("P0-OPS-05 server chain-monitor/status endpoint returns address_pool_available_count", () => {
  const server = read("src/server.mjs");

  const statusEndpointMatch = server.match(
    /app\.get\("\/api\/v1\/chain-monitor\/status"[\s\S]{0,2000}?}\s*\);/
  );
  assert.ok(statusEndpointMatch, "chain-monitor/status endpoint not found");

  const endpointBody = statusEndpointMatch[0];
  assert.match(endpointBody, /address_pool_available_count/);
  assert.match(endpointBody, /receive_addresses.*status.*available/);
});
