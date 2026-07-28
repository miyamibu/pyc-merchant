import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

test("terminal session identity and effective permissions fail closed", () => {
  const html = read("public/terminal.html");
  const js = read("public/terminal.js");

  assert.match(html, /id="staffName"/);
  assert.match(html, /id="sessionIdentityText"/);
  assert.match(html, /id="sessionRoleText"/);
  assert.match(html, /id="logoutBtn"/);
  assert.match(html, /data-permission="refund\.execute"/);
  for (const id of ["createInvoiceBtn", "cancelInvoiceBtn", "expireInvoiceBtn", "reissueInvoiceBtn", "presentTapBtn", "resumeQrBtn"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-permission="invoice\\.create"`));
  }
  assert.match(html, /id="refreshBtn"[^>]*data-permission="invoice\.read"/);
  assert.match(html, /data-permission-any="review\.read settlement\.close monitor\.read"/);
  assert.match(js, /effective_permissions/);
  assert.match(js, /permissionsKnown/);
  assert.match(js, /function applyPermissionVisibility/);
  assert.match(js, /sessionEpoch/);
  assert.match(js, /new AbortController\(\)/);
  assert.match(js, /assertRequestContextCurrent\(context\)/);
  assert.match(js, /response\.status === 401 && context\.resetOn401/);
  assert.match(js, /resetSessionUi\("セッションが無効または期限切れです"\)/);
  assert.match(js, /response\.status === 403/);
  assert.match(js, /この操作の権限がありません/);
  assert.match(js, /DELETE["']?[\s\S]*\/api\/v1\/terminal-sessions\/current|method: "DELETE"/);
  assert.match(js, /logoutRetryToken/);
  assert.match(js, /logoutIdempotencyKey/);
  assert.match(js, /bindToSession: false/);
  assert.match(js, /el\.staffPin\.value = ""/);
  assert.match(js, /el\.staffPinConfirm\.value = ""/);
  assert.doesNotMatch(js, /function isAdminRole/);
});

test("authorized store users always have a scoped audited payment stop control", () => {
  const html = read("public/terminal.html");
  const js = read("public/terminal.js");
  const css = read("public/app.css");
  const server = read("src/server.mjs");

  assert.match(html, /id="stickyStack"[^>]*class="sticky-stack[^"]*"[\s\S]*id="fulfillmentDecisionBanner"[\s\S]*id="storePaymentsMount"/);
  assert.match(html, /<template id="storePaymentsControlTemplate">[\s\S]*id="storePaymentsControl"[^>]*[\s\S]*?data-permission="payments\.control"/);
  assert.match(html, /id="storePaymentsToggleBtn"/);
  assert.match(html, /全体停止の解除や変更はできません/);
  assert.match(html, /操作は監査ログに記録されます/);
  const stickyStackCss = css.match(/\.sticky-stack\s*\{([\s\S]*?)\n\}/);
  assert.ok(stickyStackCss);
  assert.match(stickyStackCss[1], /position:\s*sticky/);
  assert.match(stickyStackCss[1], /top:\s*max\([^;]*env\(safe-area-inset-top\)/);
  const storeControlCss = css.match(/\.store-payments-control\s*\{([\s\S]*?)\n\}/);
  assert.ok(storeControlCss);
  assert.doesNotMatch(storeControlCss[1], /position:\s*(?:sticky|fixed)/);
  assert.doesNotMatch(storeControlCss[1], /top:\s*[^;]+/);
  assert.match(storeControlCss[1], /repeat\(auto-fit, minmax\(min\(100%/);
  assert.match(css, /\.sticky-stack-slot,[\s\S]*?\.admin-operations-mount\s*\{[\s\S]*?display:\s*contents/);
  assert.match(js, /requireUiPermission\("payments\.control"/);
  assert.match(js, /function mountStorePaymentsControl/);
  assert.match(js, /function bindStorePaymentsEvents/);
  assert.match(js, /\/api\/v1\/admin\/stores\/\$\{encodeURIComponent\(state\.storeId\)\}\/payments\/\$\{action\}/);
  assert.doesNotMatch(js, /\/api\/v1\/admin\/payments\/(?:disable|enable)/);
  assert.match(js, /const action = storeDisabled \? "enable" : "disable"/);
  assert.match(js, /paymentIssuanceAllowed\(\)/);
  assert.match(js, /state\.paymentsReadState === "ready"/);
  assert.match(server, /payments: getPaymentsDisableState\(\{ storeId: terminal\.store_id, terminalId: terminal\.id \}\)/);
  assert.match(server, /payments\.store_disabled/);
  assert.match(server, /payments\.store_enabled/);
});

test("terminal keeps staff actions in the base DOM and only materializes gated management DOM after authorization", () => {
  const html = read("public/terminal.html");
  const js = read("public/terminal.js");
  const storeTemplate = html.match(/<template id="storePaymentsControlTemplate">[\s\S]*?<\/template>/);
  const adminTemplate = html.match(/<template id="adminOperationsTemplate">[\s\S]*?<\/template>/);
  assert.ok(storeTemplate, "store payment control must be held in a removable template");
  assert.ok(adminTemplate, "admin operations must be held in a removable template");

  const baseHtml = html
    .replace(storeTemplate[0], "")
    .replace(adminTemplate[0], "");
  assert.match(baseHtml, /id="createInvoiceBtn"[^>]*data-permission="invoice\.create"/);
  assert.match(baseHtml, /id="refreshBtn"[^>]*data-permission="invoice\.read"/);
  assert.doesNotMatch(baseHtml, /data-admin-only=/);
  assert.doesNotMatch(baseHtml, /id="storePaymentsControl"/);
  assert.match(adminTemplate[0], /data-admin-only="true"/);
  assert.match(adminTemplate[0], /id="loadReviewsBtn"/);
  assert.match(adminTemplate[0], /id="closeSettlementBtn"/);

  assert.match(js, /storePaymentsControlTemplate\?\.remove\(\)/);
  assert.match(js, /adminOperationsTemplate\?\.remove\(\)/);
  assert.match(js, /function mountAdminOperations/);
  assert.match(js, /state\.token && state\.permissionsKnown && hasAnyPermission\(ADMIN_UI_PERMISSIONS\)/);
  assert.match(js, /mount\.replaceChildren\(\)/);
  assert.match(js, /function bindAdminEvents/);
  assert.match(js, /el\.adminOperationsMount\.dataset\.eventsBound/);
  assert.match(js, /refreshDynamicElementRefs\(\)/);
});

test("terminal removes disabled provider rail controls before binding events", () => {
  const html = read("public/terminal.html");
  const js = read("public/terminal.js");

  assert.match(html, /<body[^>]*data-provider-rail-enabled="false"/);
  for (const id of ["presentTapBtn", "resumeQrBtn", "providerControlHint", "tapModePanel"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-provider-rail|data-provider-rail[^>]*id="${id}"`));
  }
  assert.match(html, /<p[^>]*data-provider-rail[^>]*>[^<]*<span id="providerOperatorStateText"/);
  assert.match(html, /<p[^>]*data-provider-rail[^>]*>[^<]*<span id="providerStatusText"/);
  assert.match(js, /const PROVIDER_RAIL_ENABLED = document\.body\?\.dataset\.providerRailEnabled === "true"/);
  assert.match(js, /document\.querySelectorAll\("\[data-provider-rail\]"\)\.forEach\(\(node\) => node\.remove\(\)\)/);
  assert.ok(js.indexOf('document.querySelectorAll("[data-provider-rail]")') < js.indexOf("const el = {"));
  assert.match(js, /const tapOnly = PROVIDER_RAIL_ENABLED && providerSummary\?\.qr_available === false/);
  assert.match(js, /if \(!PROVIDER_RAIL_ENABLED \|\| !el\.presentTapBtn\) return/);
  assert.match(js, /if \(PROVIDER_RAIL_ENABLED && el\.presentTapBtn && el\.resumeQrBtn\)/);
});

test("terminal keeps fulfillment decision visible and fails closed on integrity hold", () => {
  const html = read("public/terminal.html");
  const js = read("public/terminal.js");
  const css = read("public/app.css");

  assert.match(html, /id="fulfillmentDecisionBanner"/);
  assert.match(html, /id="fulfillmentDecisionBadge"/);
  assert.match(html, /id="fulfillmentDecisionTitle"/);
  assert.match(html, /id="fulfillmentDecisionBody"/);
  assert.match(js, /function hasIntegrityHold/);
  assert.match(js, /hold_fulfillment/);
  assert.match(js, /reorg_detected/);
  assert.match(js, /if \(hasIntegrityHold\(invoice\)\) return "integrity_hold"/);
  assert.match(js, /記録整合性を確認中・渡さない/);
  assert.match(js, /renderFulfillmentDecisionBanner\(invoice\)/);
  const fulfillmentCss = css.match(/\.fulfillment-banner\s*\{([\s\S]*?)\n\}/);
  assert.ok(fulfillmentCss);
  assert.doesNotMatch(fulfillmentCss[1], /position:\s*(?:sticky|fixed)/);
  assert.match(css, /\.sticky-stack\s*\{[\s\S]*?position:\s*sticky/);
  assert.match(css, /\.fulfillment-banner\[data-decision="allow"\]/);
});

test("paid terminal invoices stay observable for post-payment reorg holds", () => {
  const js = read("public/terminal.js");
  const server = read("src/server.mjs");

  assert.match(js, /const ACTIVE_INVOICE_STATUSES = new Set\([\s\S]*"paid"[\s\S]*"settled"/);
  assert.match(js, /function shouldObserveInvoice\(invoice = state\.currentInvoice\)/);
  assert.match(js, /if \(!shouldObserveInvoice\(\)\)/);
  assert.match(js, /const FINAL_INVOICE_STATUSES = new Set\(\["cancelled"\]\)/);
  assert.match(server, /monitor_until: invoice\.monitor_until \|\| null/);
  assert.match(server, /integrity_hold: Number\(invoice\.integrity_hold \|\| 0\) === 1/);
  assert.match(server, /const writeStreamSnapshotIfChanged = \(\) =>/);
  assert.match(server, /const snapshotTimer = setInterval\(writeStreamSnapshotIfChanged, 2_000\)/);
  assert.match(js, /const FULFILLMENT_FRESHNESS_MS = 30_000/);
  assert.match(js, /function hasFreshFulfillmentObservation/);
  assert.match(js, /function isFulfillmentObservationUnavailable/);
  assert.match(js, /wouldAllowFulfillment\(invoice\)/);
  assert.match(js, /getAuthoritativeFulfillmentDecision\(invoice\)/);
  assert.match(js, /function failClosedFulfillmentObservation/);
  assert.match(js, /state\.fulfillmentFreshnessTimer = setTimeout/);
  assert.match(js, /setInvoiceStatusPill\(state\.invoiceStatus\)/);
  assert.match(js, /renderProviderControls\(state\.currentInvoice\)/);
  assert.match(js, /renderCustomerFacingQr\(\)/);
  assert.match(js, /observation_unavailable/);
  assert.match(js, /failClosedFulfillmentObservation\(\);\s*void loadInvoice\(updatedInvoiceId/);
  assert.match(js, /状態更新を確認できないため渡さない/);
});

test("terminal refreshes fulfillment evidence after iPad/Safari resume events", () => {
  const js = read("public/terminal.js");
  assert.match(js, /function refreshFulfillmentObservationAfterResume/);
  assert.match(js, /window\.addEventListener\("pageshow"/);
  assert.match(js, /window\.addEventListener\("online"/);
  assert.match(js, /document\.addEventListener\("visibilitychange"/);
  assert.match(js, /failClosedFulfillmentObservation\(\)/);
});

test("terminal fulfillment allow paths require a fresh observation", () => {
  const js = read("public/terminal.js");
  const source = [
    extractSourceBlock(js, "function getAuthoritativeFulfillmentDecision", "function effectiveOperatorStatus"),
    extractSourceBlock(js, "function wouldAllowFulfillment", "function renderFulfillmentDecisionBanner"),
  ].join("\n");
  const state = {
    lastInvoiceRefreshAt: new Date(Date.now() - 1_000).toISOString(),
    fulfillmentObservationValid: true,
    sseStatus: "open",
    fallbackPollingStatus: "idle",
  };
  const context = vm.createContext({
    state,
    PROVIDER_RAIL_ENABLED: true,
    FULFILLMENT_FRESHNESS_MS: 30_000,
    hasIntegrityHold: () => false,
    effectiveOperatorStatus: (invoice) => invoice?.status || "idle",
    getOperatorActionPolicy: () => ({
      handoff: "hold",
      next: "wait",
      manager: "manager",
    }),
  });
  vm.runInContext(`${source}\nthis.resolveForTest = resolveFulfillmentDecisionModel;`, context);

  assert.equal(context.resolveForTest({
    status: "paid",
    fulfillment_decision: { decision: "allow_fulfillment", reason_codes: [] },
  }).decision, "allow");
  assert.equal(context.resolveForTest({
    status: "payment_detected",
    provider_summary: { fulfillment_decision: { decision: "allow_fulfillment", reason_codes: [] } },
  }).decision, "allow");

  state.fulfillmentObservationValid = false;
  assert.equal(context.resolveForTest({
    status: "paid",
    fulfillment_decision: { decision: "allow_fulfillment", reason_codes: [] },
  }).decision, "hold");
  assert.equal(context.resolveForTest({
    status: "payment_detected",
    provider_summary: { fulfillment_decision: { decision: "allow_fulfillment", reason_codes: [] } },
  }).decision, "hold");

  state.fulfillmentObservationValid = true;
  state.lastInvoiceRefreshAt = new Date(Date.now() - 30_001).toISOString();
  assert.equal(context.resolveForTest({
    status: "settled",
    fulfillment_decision: { decision: "allow_fulfillment", reason_codes: [] },
  }).decision, "hold");
  assert.equal(context.resolveForTest({ status: "paid" }).decision, "hold");
});

test("terminal integrity hold overrides every provider fulfillment surface", () => {
  const js = read("public/terminal.js");

  const statusElements = { invoiceStatusPill: { textContent: "", className: "" } };
  const statusContext = vm.createContext({
    state: { currentInvoice: { status: "paid", integrity_hold: true } },
    el: statusElements,
    canonicalInvoiceStatus: (value) => value,
    hasIntegrityHold: () => true,
    isFulfillmentObservationUnavailable: () => false,
  });
  const statusSource = extractSourceBlock(js, "function setInvoiceStatusPill", "function clearQr");
  vm.runInContext(`${statusSource}\nthis.renderStatusForTest = setInvoiceStatusPill;`, statusContext);
  statusContext.renderStatusForTest("paid");
  assert.equal(statusElements.invoiceStatusPill.textContent, "記録整合性を確認中");
  assert.equal(statusElements.invoiceStatusPill.className, "status-pill s-red");

  const providerElements = {
    providerOperatorStateText: { textContent: "" },
    providerStatusText: { textContent: "" },
    providerControlHint: { textContent: "" },
    presentTapBtn: { disabled: false },
    resumeQrBtn: { disabled: false },
  };
  const providerContext = vm.createContext({
    PROVIDER_RAIL_ENABLED: true,
    state: { invoiceOperationsInFlight: new Set(), invoiceId: "inv-1" },
    el: providerElements,
    hasPermission: () => true,
    hasIntegrityHold: () => true,
    isFulfillmentObservationUnavailable: () => false,
  });
  const providerSource = extractSourceBlock(js, "function renderProviderControls", "function renderAmountCompare");
  vm.runInContext(`${providerSource}\nthis.renderProviderForTest = renderProviderControls;`, providerContext);
  providerContext.renderProviderForTest({
    status: "paid",
    integrity_hold: true,
    provider_summary: { fulfillment_decision: "allow_fulfillment" },
  });
  assert.equal(providerElements.providerStatusText.textContent, "商品引渡し保留");
  assert.equal(providerElements.presentTapBtn.disabled, true);
  assert.equal(providerElements.resumeQrBtn.disabled, true);

  const customerElements = {
    qrCanvas: { classList: { toggle() {} } },
    tapModePanel: { classList: { toggle() {} } },
    tapModeBadge: { textContent: "", className: "" },
    tapModeTitle: { textContent: "" },
    tapModeBody: { textContent: "" },
    tapModeAmount: { textContent: "" },
    customerDisplayHint: { textContent: "" },
    fixedQrUrlLink: { textContent: "", href: "", removeAttribute() {} },
  };
  const customerContext = vm.createContext({
    PROVIDER_RAIL_ENABLED: true,
    state: { fixedQrUrl: "" },
    el: customerElements,
    hasIntegrityHold: () => true,
    isFulfillmentObservationUnavailable: () => false,
    formatJpy: () => "¥1,250",
    drawQr() {},
    clearQr() {},
  });
  const customerSource = extractSourceBlock(js, "function providerBadgeClass", "function renderCustomerFacingQr");
  vm.runInContext(`${customerSource}\nthis.renderCustomerForTest = renderCustomerFacingDisplay;`, customerContext);
  customerContext.renderCustomerForTest({
    status: "paid",
    integrity_hold: true,
    amounts: { amount_jpy: 1250 },
    provider_summary: {
      qr_available: false,
      operator_state: { code: "fulfillment_ok", label: "商品引渡しOK" },
    },
  });
  assert.equal(customerElements.tapModeBadge.className, "status-pill s-red");
  assert.match(customerElements.tapModeTitle.textContent, /まだ渡さない/);
});

test("terminal observer connection changes rerender every fulfillment surface", () => {
  const js = read("public/terminal.js");
  let safetyRenderCount = 0;
  const context = vm.createContext({
    state: {},
    nowIso: () => "2026-07-25T00:00:00.000Z",
    renderConnectionStatus() {},
    renderDiagnostics() {},
    renderFulfillmentSafetySurfaces() { safetyRenderCount += 1; },
  });
  const source = extractSourceBlock(js, "function setSseStatus", "function renderDiagnostics");
  vm.runInContext(`${source}\nthis.setSseForTest = setSseStatus; this.setFallbackForTest = setFallbackPollingStatus;`, context);

  context.setFallbackForTest("active", "SSE fallback polling");
  assert.equal(context.state.fallbackPollingStatus, "active");
  assert.equal(safetyRenderCount, 1);

  context.setSseForTest("open", "connected");
  assert.equal(context.state.sseStatus, "open");
  assert.equal(safetyRenderCount, 2);
});

test("terminal keeps iPad landscape in columns and all terminal controls at least 48px", () => {
  const html = read("public/terminal.html");
  const css = read("public/app.css");

  assert.match(html, /terminal-session-card/);
  assert.match(html, /terminal-invoice-card/);
  assert.match(css, /\.terminal-surface\s*\{\s*--control-height:\s*48px;\s*--tap-target-min:\s*48px;/);
  assert.match(css, /\.terminal-surface \.btn-compact,[\s\S]*?min-height:\s*var\(--tap-target-min\)/);
  assert.match(css, /\.terminal-surface \.preset-chip \.btn-remove\s*\{\s*min-width:\s*var\(--tap-target-min\)/);
  assert.match(css, /@media \(min-width: 900px\) and \(max-width: 1160px\)[\s\S]*?\.terminal-surface \.grid-main\s*\{\s*grid-template-columns:\s*repeat\(12/);
  assert.match(css, /\.terminal-surface \.terminal-session-card\s*\{\s*grid-column:\s*span 3/);
  assert.match(css, /\.terminal-surface \.terminal-invoice-card\s*\{\s*grid-column:\s*span 9/);
  assert.match(css, /\.terminal-surface \.metrics-grid,[\s\S]*?grid-template-columns:\s*repeat\(2/);
  assert.match(css, /@media \(max-width: 899px\)/);
});

test("refund request uses one stable operation key and server read-back", () => {
  const html = read("public/terminal.html");
  const js = read("public/terminal.js");

  assert.doesNotMatch(html, /id="refundAmount"[^>]*value="100"/);
  assert.match(html, /id="refundEligibleHint"/);
  assert.match(js, /refundRequestIdempotencyKey/);
  assert.match(js, /"idempotency-key": requestOperation\.idempotencyKey/);
  assert.match(js, /state\.refundRequestInFlight/);
  assert.match(js, /state\.refundRequestOperations\.get\(requestSignature\)/);
  assert.match(js, /requestOperation\.completed/);
  assert.match(js, /async function readBackRefund/);
  assert.match(js, /await tryReadBackRefund\(refundId, "返金申請の作成"\)/);
});

test("business dates are timezone-aware and audit viewing remains authenticated", () => {
  const html = read("public/terminal.html");
  const js = read("public/terminal.js");

  assert.match(html, /id="businessTimezoneText"/);
  assert.match(js, /timeZone: safeTimeZone\(state\.storeTimezone\)/);
  assert.match(js, /\$\{businessDate\}（\$\{state\.storeTimezone\}）/);
  assert.match(html, /id="openAuditLogBtn"/);
  assert.doesNotMatch(html, /href="\/api\/v1\/audit-logs/);
  assert.match(js, /requestJson\("\/api\/v1\/audit-logs\?limit=50"\)/);
  assert.match(js, /requireUiPermission\("audit\.read"/);
});

test("fixed terminal entry requires explicit confirmation and rechecks before navigation", () => {
  const html = read("public/terminal-entry.html");
  const js = read("public/terminal-entry.js");

  assert.match(html, /id="entryReadyPanel"/);
  assert.match(html, /id="entryAmountText"/);
  assert.match(html, /id="entryInvoiceText"/);
  assert.match(html, /id="openInvoiceBtn"[^>]*>この会計を確認して進む</);
  assert.match(html, /id="refreshEntryBtn"/);
  assert.match(js, /async function handleOpenInvoice/);
  assert.match(js, /const latestEntry = await requestEntryState\(\)/);
  assert.match(js, /readyFingerprint\(latestEntry\) !== readyFingerprint\(selectedEntry\)/);
  assert.match(js, /requiresReconfirmation/);
  assert.match(js, /変更内容を確認/);
  assert.match(js, /REQUEST_TIMEOUT_MS = 8000/);
  assert.match(js, /signal: controller\.signal/);
  assert.match(js, /function isExpectedPayDestination/);
  assert.match(js, /destination\.pathname === "\/pay"/);
  assert.match(js, /destination\.searchParams\.getAll\("ref"\)\.length === 1/);
  assert.match(js, /window\.location\.replace\(destination\.href\)/);
  assert.doesNotMatch(js, /if \(entry\.status === "ready"\) \{\s*(?:redirect|window\.location)/);
});

test("fixed terminal entry accepts only the canonical same-origin signed pay path", () => {
  const js = read("public/terminal-entry.js");
  const source = extractSourceBlock(js, "function isExpectedPayDestination", "function renderWaiting");
  const context = vm.createContext({ window: { location: { origin: "https://merchant.example.jp" } } });
  vm.runInContext(`${source}\nthis.isExpected = isExpectedPayDestination;`, context);
  const isExpected = context.isExpected;
  assert.equal(isExpected(new URL("https://merchant.example.jp/pay?ref=signed-value")), true);
  for (const candidate of [
    "https://attacker.example/pay?ref=signed-value",
    "https://merchant.example.jp/mobile.html?ref=signed-value",
    "https://merchant.example.jp/pay",
    "https://merchant.example.jp/pay?ref=a&ref=b",
    "https://merchant.example.jp/pay?ref=a&next=%2Fadmin",
    "https://merchant.example.jp/pay?ref=a#fragment",
    "https://user:secret@merchant.example.jp/pay?ref=a",
  ]) {
    assert.equal(isExpected(new URL(candidate)), false, candidate);
  }
});

test("fixed terminal entry maps server errors to a safe customer catalog", () => {
  const js = read("public/terminal-entry.js");
  assert.doesNotMatch(js, /payload\?\.error\?\.message/);
  assert.doesNotMatch(js, /error\.message/);
  const source = extractSourceBlock(js, "const TERMINAL_ENTRY_ERROR_CATALOG", "function announce");
  const context = vm.createContext({ Error, Object, String });
  vm.runInContext(
    `${source}\nthis.fromResponse = terminalEntryErrorFromResponse;\nthis.toCustomerText = customerFacingTerminalError;`,
    context,
  );

  const rawDetails = {
    code: "INTERNAL_ERROR",
    message: "sqlite:///var/lib/jpyc/app.db RPC https://rpc.internal.example stack leaked",
    details: { stack: "Error: secret at /srv/jpyc/src/server.mjs:42" },
  };
  const mappedUnknown = context.toCustomerText(
    context.fromResponse({ error: rawDetails }, "ENTRY_REFRESH_FAILED"),
    "ENTRY_REFRESH_FAILED",
  );
  const mappedKnown = context.toCustomerText(
    context.fromResponse({
      error: {
        code: "CHECKOUT_CLAIM_STALE",
        message: rawDetails.message,
        details: rawDetails.details,
      },
    }, "ENTRY_CLAIM_FAILED"),
    "ENTRY_CLAIM_FAILED",
  );
  for (const text of [mappedUnknown, mappedKnown]) {
    assert.match(text, /問い合わせコード:/);
    for (const secret of ["sqlite", "app.db", "rpc.internal.example", "/srv/jpyc", "secret at"]) {
      assert.equal(text.includes(secret), false, `customer error exposed ${secret}`);
    }
  }
});

function extractSourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function response({ ok = true, status = 200, payload = {} } = {}) {
  return {
    ok,
    status,
    headers: new Headers(),
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function createRequestHarness() {
  const js = read("public/terminal.js");
  const source = extractSourceBlock(js, "function parseErrorMessage", "function setInvoiceStatusPill");
  let resetCalls = 0;
  const context = vm.createContext({
    AbortController,
    Headers,
    state: {
      token: "old-token",
      sessionEpoch: 1,
      requestControllers: new Set(),
    },
    fetch: null,
    resetSessionUi() {
      resetCalls += 1;
      for (const controller of context.state.requestControllers) controller.abort();
      context.state.requestControllers.clear();
      context.state.sessionEpoch += 1;
      context.state.token = "";
    },
  });
  vm.runInContext(
    `${source}\nthis.requestJsonForTest = requestJson; this.advanceSessionEpochForTest = advanceSessionEpoch;`,
    context
  );
  return { context, getResetCalls: () => resetCalls };
}

test("old authenticated 200 and 401 responses cannot cross a session epoch", async () => {
  for (const staleResponse of [
    response({ payload: { value: "old-session-data" } }),
    response({ ok: false, status: 401, payload: { error: { message: "old unauthorized" } } }),
  ]) {
    const { context, getResetCalls } = createRequestHarness();
    let releaseFetch;
    context.fetch = () => new Promise((resolve) => {
      releaseFetch = resolve;
    });
    const pending = context.requestJsonForTest("/old-session");
    context.advanceSessionEpochForTest();
    context.state.token = "new-token";
    releaseFetch(staleResponse);
    await assert.rejects(pending, (error) => error?.code === "STALE_SESSION_RESPONSE");
    assert.equal(getResetCalls(), 0, "an old 401 must not clear the new session");
    assert.equal(context.state.token, "new-token");
  }
});

test("current-session 401 still fails closed and clears the active session", async () => {
  const { context, getResetCalls } = createRequestHarness();
  context.fetch = async () => response({
    ok: false,
    status: 401,
    payload: { error: { message: "expired" } },
  });
  await assert.rejects(
    context.requestJsonForTest("/current-session"),
    (error) => error?.code === "STALE_SESSION_RESPONSE"
  );
  assert.equal(getResetCalls(), 1);
  assert.equal(context.state.token, "");
});

test("ops review uncertainty blocks settlement close instead of rendering zero", () => {
  const js = read("public/terminal.js");
  const opsSource = extractSourceBlock(js, "async function loadOpsSnapshot", "function startOpsAutoRefresh");
  assert.match(js, /const reviewsAvailable = Boolean/);
  assert.match(js, /state\.opsReviewReadState = reviewsAvailable \? "ok"/);
  assert.match(js, /reviewsAvailable\s*\? `\$\{openReviewCount\}件`\s*:\s*"取得失敗"/);
  assert.match(js, /state\.opsReviewReadState !== "ok"/);
  assert.match(js, /state\.opsSettlementReadState !== "ok"/);
  assert.match(js, /締め前提の運用状態が不明なため、日次締めは実行できません/);
  assert.match(opsSource, /snapshotSequence !== state\.opsSnapshotSequence/);
  assert.match(opsSource, /state\.opsSnapshotBusinessDate !== businessDate/);
  assert.match(opsSource, /String\(el\.businessDateInput\.value \|\| ""\)\.trim\(\) !== businessDate/);
});

test("same-session late invoice and review responses cannot overwrite the latest target", async () => {
  const js = read("public/terminal.js");
  const invoiceSource = extractSourceBlock(js, "async function loadInvoice", "function applyAmountPreset");
  const invoiceResolvers = new Map();
  const renderedInvoices = [];
  const invoiceContext = vm.createContext({
    state: {
      invoiceRequestSequence: 0,
      latestInvoiceRequestId: "",
      lastInvoiceRefreshAt: "",
      fulfillmentObservationValid: false,
    },
    el: { invoiceStatusPill: { textContent: "" } },
    requestJson(pathname) {
      return new Promise((resolve) => invoiceResolvers.set(pathname, resolve));
    },
    nowIso: () => "2026-07-15T00:00:00.000Z",
    renderInvoice(invoice) { renderedInvoices.push(invoice.invoice_id); },
    scheduleFulfillmentFreshnessHold() {},
    failClosedFulfillmentObservation() {},
    showToast() {},
    isIgnoredRequestError: () => false,
  });
  vm.runInContext(`${invoiceSource}\nthis.loadInvoiceForTest = loadInvoice;`, invoiceContext);

  const invoiceA = invoiceContext.loadInvoiceForTest("invoice-a", { silent: true });
  const invoiceB = invoiceContext.loadInvoiceForTest("invoice-b", { silent: true });
  invoiceResolvers.get("/api/v1/invoices/invoice-b")({ invoice_id: "invoice-b" });
  assert.equal((await invoiceB).status, "ok");
  invoiceResolvers.get("/api/v1/invoices/invoice-a")({ invoice_id: "invoice-a" });
  assert.equal((await invoiceA).status, "stale");
  assert.deepEqual(renderedInvoices, ["invoice-b"]);

  const reviewSource = extractSourceBlock(js, "async function selectReview", "function createReviewRow");
  const reviewResolvers = new Map();
  const renderedReviews = [];
  const reviewContext = vm.createContext({
    state: { reviewDetailSequence: 0, reviewDetailRequestId: "", selectedReviewId: "" },
    el: { reviewIdInput: { value: "" } },
    hasPermission: () => true,
    highlightSelectedReviewRow() {},
    requestJson(pathname) {
      return new Promise((resolve) => reviewResolvers.set(pathname, resolve));
    },
    renderReviewDetail(detail) { renderedReviews.push(detail?.review?.id || null); },
    showToast() {},
    isIgnoredRequestError: () => false,
  });
  vm.runInContext(`${reviewSource}\nthis.selectReviewForTest = selectReview;`, reviewContext);

  const reviewA = reviewContext.selectReviewForTest("review-a");
  const reviewB = reviewContext.selectReviewForTest("review-b");
  reviewResolvers.get("/api/v1/reviews/review-b")({ review: { id: "review-b" } });
  assert.equal((await reviewB).status, "ok");
  reviewResolvers.get("/api/v1/reviews/review-a")({ review: { id: "review-a" } });
  assert.equal((await reviewA).status, "stale");
  assert.deepEqual(renderedReviews, ["review-b"]);
});

test("refund operations share one target lock and rotate retryable verify keys", () => {
  const js = read("public/terminal.js");
  const stableKeySource = extractSourceBlock(js, "function getStableOperationKey", "function hasPermission");
  const refundStepSource = extractSourceBlock(js, "function updateRefundStepState", "function stopSessionExpiryTimer");
  const refundSource = extractSourceBlock(js, "function normalizeDecimalSignature", "async function handleRequestRefund");
  const verifySource = extractSourceBlock(js, "async function handleVerifyRefund", "async function handleCloseSettlement");
  assert.match(refundStepSource, /state\.refundOperationTargetsInFlight\.has\(currentRefundId\)/);
  assert.match(refundStepSource, /approveRefundBtn\.disabled[\s\S]*currentRefundBusy/);
  assert.match(refundStepSource, /executeRefundBtn\.disabled[\s\S]*currentRefundBusy/);
  assert.match(refundStepSource, /verifyRefundBtn\.disabled[\s\S]*currentRefundBusy/);
  assert.match(verifySource, /releaseRefundVerifyKeyAfterResult\(operation, data\)/);
  assert.match(verifySource, /releaseRefundVerifyKeyAfterError\(operation, error\)/);
  let keyCount = 0;
  const element = (value = "") => ({ value, disabled: false });
  const el = {
    refundReviewCaseId: element("review-a"),
    refundAmount: element("300.0"),
    refundAddress: element("0x2222222222222222222222222222222222222222"),
    refundChainId: element("137"),
    refundEvidenceNotePathInput: element("evidence-a"),
    refundCustomerNoteInput: element("note-a"),
    refundIdInput: element("refund-a"),
    refundTxHashInput: element(`0x${"a".repeat(64)}`),
    refundExecutedWalletInput: element("0x3333333333333333333333333333333333333333"),
  };
  const state = {
    pendingRefundExecute: "",
    pendingRefundExecuteTimer: null,
    refundRequestOperations: new Map(),
    refundRequestSignature: "",
    refundRequestIdempotencyKey: "",
    refundRequestCompletedSignature: "",
    refundOperationsInFlight: new Set(),
    refundOperationTargetsInFlight: new Set(),
    refundOperationKeys: new Map(),
    refundRequestInFlight: false,
  };
  const context = vm.createContext({
    state,
    el,
    clearTimeout,
    idempotencyKey: (kind) => `${kind}-key-${++keyCount}`,
    REFUND_VERIFY_RETRYABLE_STATUSES: new Set(["recorded", "pending_verification", "verification_failed", "failed"]),
    updateRefundStepState() {},
  });
  vm.runInContext(
    `${stableKeySource}\n${refundSource}\nthis.buildRequestSignature = buildRefundRequestSignature; this.handleDraft = handleRefundDraftChanged; this.buildExecuteSignature = buildRefundExecuteSignature; this.beginOperation = beginRefundOperation; this.endOperation = endRefundOperation; this.releaseVerifyResult = releaseRefundVerifyKeyAfterResult; this.releaseVerifyError = releaseRefundVerifyKeyAfterError;`,
    context
  );

  const signatureA = context.buildRequestSignature();
  state.refundRequestOperations.set(signatureA, { idempotencyKey: "saved-key-a", completed: true });
  context.handleDraft();
  assert.equal(state.refundRequestIdempotencyKey, "saved-key-a");
  assert.equal(state.refundRequestCompletedSignature, signatureA);

  el.refundAmount.value = "400";
  context.handleDraft();
  assert.equal(state.refundRequestIdempotencyKey, "");
  el.refundAmount.value = "0300.000";
  context.handleDraft();
  assert.equal(context.buildRequestSignature(), signatureA, "equivalent decimal input must retain one semantic signature");
  assert.equal(state.refundRequestIdempotencyKey, "saved-key-a");

  const executeA = context.buildExecuteSignature();
  el.refundIdInput.value = "refund-b";
  const executeB = context.buildExecuteSignature();
  assert.notEqual(executeA, executeB, "confirmation must bind the refund target");
  el.refundIdInput.value = "refund-a";
  const first = context.beginOperation("refund-execute", executeA, "refund-a");
  assert.ok(first);
  assert.equal(context.beginOperation("refund-execute", executeA, "refund-a"), null, "rapid duplicate must be locked");
  assert.equal(
    context.beginOperation("refund-verify", JSON.stringify({ refund_id: "refund-a" }), "refund-a"),
    null,
    "approve, execute, and verify must share one refund-target lock"
  );
  context.endOperation(first);
  const retry = context.beginOperation("refund-execute", executeA, "refund-a");
  assert.equal(retry.idempotencyKey, first.idempotencyKey, "retry must reuse the semantic operation key");
  context.endOperation(retry);

  const verifySignature = JSON.stringify({ refund_id: "refund-a", refund_tx_hash: `0x${"a".repeat(64)}` });
  const pendingAttempt = context.beginOperation("refund-verify", verifySignature, "refund-a");
  context.releaseVerifyResult(pendingAttempt, { status: "pending_verification" });
  context.endOperation(pendingAttempt);
  const afterPending = context.beginOperation("refund-verify", verifySignature, "refund-a");
  assert.notEqual(afterPending.idempotencyKey, pendingAttempt.idempotencyKey, "pending verification must allow a fresh chain check");
  context.releaseVerifyResult(afterPending, { status: "verification_failed" });
  context.endOperation(afterPending);
  const afterFailure = context.beginOperation("refund-verify", verifySignature, "refund-a");
  assert.notEqual(afterFailure.idempotencyKey, afterPending.idempotencyKey, "verification failure must allow a fresh chain check");
  context.releaseVerifyResult(afterFailure, { status: "succeeded" });
  context.endOperation(afterFailure);
  const finalReplay = context.beginOperation("refund-verify", verifySignature, "refund-a");
  assert.equal(finalReplay.idempotencyKey, afterFailure.idempotencyKey, "final success must keep the safe replay key");
  context.endOperation(finalReplay);

  const knownError = context.beginOperation("refund-verify", "known-error", "refund-a");
  context.releaseVerifyError(knownError, { status: 409, code: "INVALID_STATE_TRANSITION" });
  context.endOperation(knownError);
  const afterKnownError = context.beginOperation("refund-verify", "known-error", "refund-a");
  assert.notEqual(afterKnownError.idempotencyKey, knownError.idempotencyKey, "a known HTTP result must not pin later attempts to a cached error");
  context.endOperation(afterKnownError);

  const inProgress = context.beginOperation("refund-verify", "in-progress", "refund-a");
  context.releaseVerifyError(inProgress, { status: 409, code: "IDEMPOTENCY_IN_PROGRESS" });
  context.endOperation(inProgress);
  const inProgressRetry = context.beginOperation("refund-verify", "in-progress", "refund-a");
  assert.equal(inProgressRetry.idempotencyKey, inProgress.idempotencyKey, "an in-progress server claim must keep the same key");
  context.endOperation(inProgressRetry);
});

test("logout failure keeps only a retry token and stable operation key in memory", () => {
  const js = read("public/terminal.js");
  const logoutSource = extractSourceBlock(js, "function enterLogoutRetryState", "async function handleCreateInvoice");
  assert.match(logoutSource, /state\.logoutRetryToken \|\| state\.token/);
  assert.match(logoutSource, /state\.logoutIdempotencyKey \|\| idempotencyKey\("terminal-logout"\)/);
  assert.match(logoutSource, /if \(error\.status === 401\)/);
  assert.match(logoutSource, /enterLogoutRetryState\(/);
  assert.match(logoutSource, /bindToSession: false/);
  assert.match(js, /機密情報を非表示にしました/);
  assert.match(js, /ログアウトを再試行/);
});

test("logout retry reuses the same token and idempotency key until success", async () => {
  const js = read("public/terminal.js");
  const source = extractSourceBlock(js, "function enterLogoutRetryState", "async function handleCreateInvoice");
  const attempts = [];
  const resets = [];
  const state = {
    token: "active-token",
    logoutRetryToken: "",
    logoutIdempotencyKey: "",
    logoutInFlight: false,
  };
  let requestMode = "fail";
  const context = vm.createContext({
    state,
    el: { logoutBtn: { disabled: false } },
    idempotencyKey: () => "logout-operation-key",
    showToast() {},
    resetSessionUi(reason, options = {}) {
      resets.push({ reason, options });
      state.token = "";
      state.logoutRetryToken = String(options.logoutRetryToken || "");
      state.logoutIdempotencyKey = String(options.logoutIdempotencyKey || "");
      state.logoutInFlight = false;
    },
    async requestJson(pathname, options, policy) {
      attempts.push({ pathname, options, policy });
      if (requestMode === "fail") {
        const error = new Error("network failure");
        error.status = 503;
        throw error;
      }
      return { ok: true };
    },
  });
  vm.runInContext(`${source}\nthis.handleLogoutForTest = handleLogout;`, context);

  await context.handleLogoutForTest();
  assert.equal(state.token, "");
  assert.equal(state.logoutRetryToken, "active-token");
  assert.equal(state.logoutIdempotencyKey, "logout-operation-key");
  assert.equal(attempts[0].policy.authToken, "active-token");
  assert.equal(attempts[0].options.headers["idempotency-key"], "logout-operation-key");

  requestMode = "success";
  await context.handleLogoutForTest();
  assert.equal(attempts[1].policy.authToken, "active-token");
  assert.equal(attempts[1].options.headers["idempotency-key"], "logout-operation-key");
  assert.equal(state.logoutRetryToken, "");
  assert.equal(state.logoutIdempotencyKey, "");
  assert.equal(resets.length, 2, "failure enters retry state and success fully clears it");
});

function fakeElement(host = null) {
  const children = [];
  const classes = new Set();
  const listeners = new Map();
  let innerHtml = "";
  return {
    children,
    dataset: {},
    className: "",
    disabled: false,
    textContent: "",
    classList: {
      add(...names) {
        for (const name of names) classes.add(name);
      },
      remove(...names) {
        for (const name of names) classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    appendChild(child) {
      const existing = children.indexOf(child);
      if (existing >= 0) children.splice(existing, 1);
      children.push(child);
      child.parentHost = this;
      return child;
    },
    remove() {
      const parent = this.parentHost || host;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
    },
    set innerHTML(value) {
      innerHtml = value;
      if (value === "") children.length = 0;
    },
    get innerHTML() {
      return innerHtml;
    },
    get firstElementChild() {
      return children[0] || null;
    },
  };
}

test("toast queue deduplicates, replaces old success, and stays at two items", () => {
  const js = read("public/terminal.js");
  const css = read("public/app.css");
  const source = extractSourceBlock(js, "function removeToast", "function setLoggedInUi");
  const toastHost = fakeElement();
  let timerId = 0;
  const timers = new Map();
  const context = vm.createContext({
    el: { toastHost },
    document: { createElement: () => fakeElement(toastHost) },
    setTimeout(callback) {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  vm.runInContext(`${source}\nthis.showToastForTest = showToast;`, context);

  context.showToastForTest("成功A");
  context.showToastForTest("成功B");
  assert.deepEqual(toastHost.children.map((toast) => toast.textContent), ["成功B"]);
  context.showToastForTest("警告A", true);
  const firstWarningTimer = toastHost.children[1].dismissTimer;
  context.showToastForTest("警告A", true);
  assert.equal(toastHost.children.length, 2);
  assert.notEqual(toastHost.children[1].dismissTimer, firstWarningTimer);
  assert.equal(timers.has(firstWarningTimer), false);
  context.showToastForTest("警告B", true);
  assert.deepEqual(toastHost.children.map((toast) => toast.textContent), ["警告A", "警告B"]);

  const hostRule = css.match(/\.toast-host\s*\{[^}]*\}/)?.[0] || "";
  assert.match(hostRule, /top:/);
  assert.match(hostRule, /pointer-events:\s*none/);
  assert.doesNotMatch(hostRule, /bottom:/);
});

test("fixed entry poll change requires one acknowledgement before navigation", async () => {
  const source = read("public/terminal-entry.js");
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  const responses = [];
  const navigations = [];
  const location = {
    search: "?token=terminal-token",
    origin: "https://merchant.example",
    replace(value) {
      navigations.push(value);
    },
  };
  const context = vm.createContext({
    AbortController,
    DOMException,
    URL,
    URLSearchParams,
    location,
    window: {
      location,
      addEventListener() {},
      setTimeout: () => 1,
    },
    document: {
      getElementById: getElement,
      createElement: () => fakeElement(),
    },
    fetch: async () => {
      assert.ok(responses.length > 0, "unexpected terminal-entry fetch");
      const payload = responses.shift();
      return response({ payload });
    },
    setInterval: () => 1,
    clearInterval() {},
    clearTimeout() {},
  });
  const readyA = {
    status: "ready",
    store_name: "店舗A",
    pay_url: "/pay?ref=invoice-a",
    active_invoice: { invoice_id: "invoice-a", invoice_no: "A-001", amount_jpy: 100 },
  };
  const readyB = {
    status: "ready",
    store_name: "店舗A",
    pay_url: "/pay?ref=invoice-b",
    active_invoice: { invoice_id: "invoice-b", invoice_no: "B-002", amount_jpy: 200 },
  };
  responses.push(readyA);
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getElement("openInvoiceBtn").textContent, "この会計を確認して進む");

  responses.push(readyB);
  await vm.runInContext("refreshEntryState()", context);
  assert.equal(getElement("openInvoiceBtn").textContent, "変更内容を確認");
  assert.equal(vm.runInContext("state.requiresReconfirmation", context), true);

  await vm.runInContext("handleOpenInvoice()", context);
  assert.equal(navigations.length, 0);
  assert.equal(getElement("openInvoiceBtn").textContent, "この会計を確認して進む");
  assert.equal(vm.runInContext("state.requiresReconfirmation", context), false);

  responses.push(readyB);
  responses.push({ claim_id: "claim-b", claim_status: "claimed", invoice_id: "invoice-b" });
  await vm.runInContext("handleOpenInvoice()", context);
  assert.equal(navigations.length, 0);
  assert.equal(getElement("openInvoiceBtn").textContent, "確認して支払い画面へ");

  responses.push(readyB);
  responses.push({ claim_status: "consumed", invoice_id: "invoice-b", pay_url: "/pay?ref=invoice-b" });
  await vm.runInContext("handleOpenInvoice()", context);
  assert.deepEqual(navigations, ["https://merchant.example/pay?ref=invoice-b"]);
});
