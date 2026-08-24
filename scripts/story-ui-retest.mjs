import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  authHeaders,
  apiRequest,
  baseServerEnv,
  createInvoice,
  ingestManualPayment,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "../tests/helpers/server-process.mjs";
import {
  REQUIRED_UI_SOURCE_FILES,
  assertBrowserIdentityUnchanged,
  assertEvidenceRunComplete,
  buildCiEvidenceDirName,
  buildUiViewportWidths,
  captureBrowserBinaryIdentity,
  explicitBrowserSelection,
  resolveEvidenceRunIdentity,
  resolveSourceCommit,
} from "./ui-evidence-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const runStartedAtIso = new Date().toISOString();
const runStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
// CI identity is resolved once; an incomplete GitHub Actions context fails
// closed inside run() instead of being silently downgraded to local values.
let RUN_IDENTITY = null;
let runStartupIdentityError = null;
try {
  RUN_IDENTITY = resolveEvidenceRunIdentity(process.env);
} catch (identityError) {
  runStartupIdentityError = identityError;
}

function resolveOutDir() {
  const explicit = String(process.env.UI_EVIDENCE_OUTPUT_DIR || "").trim();
  if (explicit) {
    return path.resolve(ROOT, explicit);
  }
  if (RUN_IDENTITY?.identity_source === "github_actions") {
    return path.resolve(ROOT, "output", "playwright", buildCiEvidenceDirName(RUN_IDENTITY));
  }
  return path.resolve(ROOT, "output", "playwright", `story-ui-retest-${runStamp}`);
}

const OUT_DIR = resolveOutDir();
const PLAYWRIGHT_MODULE_CANDIDATES = [
  process.env.PLAYWRIGHT_MODULE_PATH,
  path.join(ROOT, "node_modules", "playwright", "index.mjs"),
  path.join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs"
  ),
].filter(Boolean);
const FIXTURE_NAMESPACE = "story-ui-retest-v2";
const runEvidenceState = {
  browserStarted: false,
  browserSelection: null,
  browserIdentity: null,
  expectedWidths: [],
  responsiveChecks: [],
  consoleEvents: [],
  pageErrors: [],
  httpFailures: [],
};

function deterministicTxHash(label) {
  return `0x${createHash("sha256").update(`${FIXTURE_NAMESPACE}:${label}`, "utf8").digest("hex")}`;
}

function fixtureKey(label) {
  return `${FIXTURE_NAMESPACE}:${label}`;
}

function assertUi(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = "UI_ASSERTION_FAILED";
    throw error;
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const modulePath = await firstExistingPath(PLAYWRIGHT_MODULE_CANDIDATES);
    if (!modulePath) {
      throw new Error(
        `playwright package is not available from this repository or bundled runtime. Set PLAYWRIGHT_MODULE_PATH to a Playwright index.mjs path. Original error: ${error.message}`
      );
    }
    return import(pathToFileURL(modulePath).href);
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function writeExitEvidence({ status, exitCode, error = null, details = {} }) {
  await ensureDir(OUT_DIR);
  const manifest = {
    ...details.manifest,
    status,
    exit_code: exitCode,
    run_started_at: runStartedAtIso,
    generated_at: new Date().toISOString(),
    source_commit: resolveSourceCommit(ROOT),
    ci: RUN_IDENTITY ? { ...RUN_IDENTITY } : null,
    output_dir: path.relative(ROOT, OUT_DIR),
    browser_started: Boolean(details.browser_started),
    browser_selection: details.browser_selection || null,
    browser_identity: details.browser_identity || null,
    error: error ? {
      code: String(error.code || "UI_EVIDENCE_RUN_FAILED"),
      message: String(error.message || error),
    } : null,
  };
  await writeJson(path.join(OUT_DIR, "manifest.json"), manifest);
  await fs.writeFile(path.join(OUT_DIR, "exit-code.txt"), `${exitCode}\n`, "utf8");
  return manifest;
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function fingerprintRelativeFiles(relativePaths) {
  const pairs = await Promise.all(relativePaths.map(async (relativePath) => [
    relativePath,
    await sha256File(path.join(ROOT, relativePath)),
  ]));
  return Object.fromEntries(pairs);
}

async function firstExistingPath(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function screenshot(page, name, evidence) {
  const filePath = path.join(OUT_DIR, `${String(evidence.length + 1).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  evidence.push({ name, path: path.relative(ROOT, filePath) });
  return filePath;
}

async function waitForText(page, selector, text, timeout = 12_000) {
  await page.waitForFunction(
    ({ selector: sel, text: expected }) => {
      const node = document.querySelector(sel);
      return Boolean(node && String(node.textContent || "").includes(expected));
    },
    { selector, text },
    { timeout }
  );
}

async function cleanupWithTimeout(label, task, timeoutMs = 5_000) {
  let timeoutId;
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(JSON.stringify({
      type: "story_ui.cleanup_warning",
      label,
      message: String(error?.message || error),
    }));
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseInvoiceIdFromPaymentUrl(paymentUrl) {
  const url = new URL(String(paymentUrl || ""));
  const ref = url.searchParams.get("ref");
  if (ref) {
    const decoded = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
    return decoded?.invoice_id ? String(decoded.invoice_id) : null;
  }
  return url.searchParams.get("invoiceId");
}

async function run() {
  if (runStartupIdentityError) {
    throw runStartupIdentityError;
  }
  await ensureDir(OUT_DIR);
  const browserSelection = explicitBrowserSelection(process.argv.slice(2), process.env);
  runEvidenceState.browserSelection = browserSelection;
  const browserIdentityBefore = await captureBrowserBinaryIdentity(browserSelection);
  runEvidenceState.browserIdentity = browserIdentityBefore;
  const cssText = await fs.readFile(path.join(ROOT, "public", "app.css"), "utf8");
  const viewportWidths = buildUiViewportWidths(cssText);
  runEvidenceState.expectedWidths = viewportWidths;

  const env = baseServerEnv({
    TERMINAL_CODE: "TERM-001",
    STAFF_PIN: "2468",
    SECOND_ADMIN_PIN: "8642",
    ALLOW_MANUAL_PAYMENT_INGEST: "true",
    SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS: "true",
    SETTLEMENT_UNRESOLVED_REVIEW_POLICY: "block",
    WALLET_ADAPTER_TYPE: "mock",
    ENABLE_REOWN: "false",
  });
  env.CORS_ALLOW_ORIGINS = [env.APP_HOST, "http://127.0.0.1:4173"].join(",");

  const evidence = [];
  const assertions = [];
  const consoleEvents = [];
  const pageErrors = [];
  const httpFailures = [];
  const httpAborted = [];
  const responsiveChecks = [];
  runEvidenceState.consoleEvents = consoleEvents;
  runEvidenceState.pageErrors = pageErrors;
  runEvidenceState.httpFailures = httpFailures;
  runEvidenceState.httpAborted = httpAborted;
  let started = null;
  let browser = null;

  try {
    const { chromium } = await loadPlaywright();
    started = await startServerProcess(ROOT, env);
    const apiSession = await loginAs(started.baseUrl, {
      terminalCode: env.TERMINAL_CODE,
      pin: env.STAFF_PIN,
      staffName: "Demo Staff",
    });
    const approverSession = await loginAs(started.baseUrl, {
      terminalCode: env.TERMINAL_CODE,
      pin: env.SECOND_ADMIN_PIN,
      staffName: "Demo Approver",
    });

    browser = await chromium.launch({
      headless: true,
      executablePath: browserSelection.executablePath,
    });
    runEvidenceState.browserStarted = true;
    const terminalContext = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      colorScheme: "light",
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
    });
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const terminalPage = await terminalContext.newPage();
    const mobilePage = await mobileContext.newPage();
    for (const page of [terminalPage, mobilePage]) {
      page.on("console", (msg) => {
        if (["error", "warning", "assert"].includes(msg.type())) {
          consoleEvents.push({
            page: page === terminalPage ? "terminal" : "mobile",
            type: msg.type(),
            text: msg.text(),
            location: msg.location(),
          });
        }
      });
      page.on("pageerror", (error) => {
        pageErrors.push({ page: page === terminalPage ? "terminal" : "mobile", message: error.message });
      });
      page.on("response", (response) => {
        if (response.status() < 400) return;
        const url = new URL(response.url());
        httpFailures.push({
          page: page === terminalPage ? "terminal" : "mobile",
          method: response.request().method(),
          status: response.status(),
          path: `${url.pathname}${url.search}`,
        });
      });
      page.on("requestfailed", (request) => {
        const url = new URL(request.url());
        const failureText = request.failure()?.errorText || "request_failed";
        if (failureText === "net::ERR_ABORTED") {
          // Client-side cancellation (e.g., the app's own bounded-deadline
          // AbortController or navigation during an in-flight poll). The
          // server never failed; record separately so the failure gate stays
          // about real transport/status failures.
          httpAborted.push({
            page: page === terminalPage ? "terminal" : "mobile",
            method: request.method(),
            path: `${url.pathname}${url.search}`,
            failure: failureText,
          });
          return;
        }
        httpFailures.push({
          page: page === terminalPage ? "terminal" : "mobile",
          method: request.method(),
          status: null,
          path: `${url.pathname}${url.search}`,
          failure: failureText,
        });
      });
    }

    await terminalPage.goto(`${started.baseUrl}/terminal.html`, { waitUntil: "networkidle" });
    await terminalPage.fill("#terminalCode", env.TERMINAL_CODE);
    await terminalPage.fill("#staffName", "Demo Staff");
    await terminalPage.fill("#staffPin", env.STAFF_PIN);
    await terminalPage.click("#loginBtn");
    await terminalPage.waitForFunction(() => {
      const node = document.getElementById("sessionText");
      return Boolean(node && String(node.textContent || "").trim() !== "未接続");
    });
    await screenshot(terminalPage, "employee-terminal-login", evidence);
    assertions.push({ story_ids: ["ES-001", "AS-003"], result: "pass", evidence: "employee-terminal-login" });

    await terminalPage.fill("#amountInput", "1250");
    await terminalPage.click("#createInvoiceBtn");
    await terminalPage.waitForFunction(() => {
      const node = document.getElementById("invoiceIdText");
      return Boolean(node && String(node.textContent || "").trim() !== "-");
    });
    await waitForText(terminalPage, "#operatorGuideList", "商品引渡し: まだ渡さない");
    await screenshot(terminalPage, "employee-invoice-issued", evidence);
    assertions.push({ story_ids: ["ES-002", "ES-003", "ES-005", "ES-006", "ES-007"], result: "pass", evidence: "employee-invoice-issued" });

    const paymentUrl = await terminalPage.getAttribute("#paymentUrlLink", "href");
    const invoiceId = parseInvoiceIdFromPaymentUrl(paymentUrl);
    if (!invoiceId) throw new Error("failed to parse invoice id from terminal payment URL");

    await mobilePage.goto(apiSession.fixedQrUrl, { waitUntil: "networkidle" });
    await waitForText(mobilePage, "#entryAmountText", "¥1,250");
    const fixedEntryOpenDisabled = await mobilePage.locator("#openInvoiceBtn").isDisabled();
    if (fixedEntryOpenDisabled) throw new Error("fixed terminal entry confirmation button stayed disabled");
    await screenshot(mobilePage, "user-fixed-entry-confirmation", evidence);
    assertions.push({ story_ids: ["US-001", "ES-003"], result: "pass", evidence: "user-fixed-entry-confirmation" });
    await Promise.all([
      mobilePage.waitForURL((url) => url.pathname.endsWith("/mobile.html")),
      mobilePage.click("#openInvoiceBtn"),
    ]);
    await mobilePage.waitForSelector("#amountText");
    await screenshot(mobilePage, "user-payment-open", evidence);
    await mobilePage.locator("#technicalDetails").evaluate((node) => {
      node.open = true;
      node.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
    await waitForText(mobilePage, "#verifyNetworkText", env.CHAIN_ID);
    await waitForText(mobilePage, "#errorBannerText", "規約3点の公開URLまたは承認版を確認できないため");
    const policyGateState = await mobilePage.locator(
      "#walletPayBtn, #showMethodsBtn, #copyInfoBtn, #consentCheckbox"
    ).evaluateAll((nodes) => nodes.map((node) => ({ id: node.id, disabled: node.disabled })));
    if (policyGateState.some((control) => !control.disabled)) {
      throw new Error(`missing policy URLs left payment or consent enabled: ${JSON.stringify(policyGateState)}`);
    }
    const blockedSurfaceState = await mobilePage.locator(
      "#secondaryPaymentActions, #paymentRecoveryDetails, #walletSupportCard, #paymentConditionsCard, #paymentVerifyCard, #technicalDetails, #consentGateSection"
    ).evaluateAll((nodes) => nodes.map((node) => ({
      id: node.id,
      hidden: getComputedStyle(node).display === "none",
    })));
    assertUi(
      blockedSurfaceState.every((surface) => surface.hidden),
      `policy blocker left a lower payment surface visible: ${JSON.stringify(blockedSurfaceState)}`
    );
    await screenshot(mobilePage, "user-policy-gate-blocked", evidence);
    assertions.push({
      story_ids: ["US-001", "US-002", "US-007"],
      result: "pass",
      evidence: "user-policy-gate-blocked",
      note: "The repository intentionally keeps unapproved policy URLs empty and policy versions in draft state, so payment actions remain fail-closed in this local run.",
    });

    await ingestManualPayment(
      started.baseUrl,
      apiSession.token,
      {
        invoice_id: invoiceId,
        amount_jpyc: 1250,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 3,
        tx_hash: deterministicTxHash("exact-payment"),
        from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      fixtureKey("exact-payment")
    );
    await mobilePage.click("#refreshBtn", { force: true });
    await waitForText(mobilePage, "#statusPill", "支払い確認済み");
    const paidActionStates = await mobilePage.locator(
      "#walletPayBtn, #showMethodsBtn, #copyInfoBtn, #copyAddressBtn, #copyAmountBtn, #copyInvoiceBtn"
    ).evaluateAll((nodes) => nodes.map((node) => ({
      id: node.id,
      disabled: node.disabled,
      backgroundColor: getComputedStyle(node).backgroundColor,
    })));
    if (paidActionStates.some((control) => !control.disabled)) {
      throw new Error(`paid invoice left payment action enabled: ${JSON.stringify(paidActionStates)}`);
    }
    const paidWalletAction = paidActionStates.find((control) => control.id === "walletPayBtn");
    if (paidWalletAction?.backgroundColor === "rgb(30, 91, 206)") {
      throw new Error(`paid wallet action still looks enabled: ${JSON.stringify(paidWalletAction)}`);
    }
    await screenshot(mobilePage, "user-paid-receipt", evidence);
    assertions.push({ story_ids: ["US-004"], result: "pass", evidence: "user-paid-receipt" });
    for (const width of viewportWidths) {
      const height = width <= 430 ? 844 : 960;
      for (const [surface, page] of [["mobile", mobilePage], ["terminal", terminalPage]]) {
        const eventStart = {
          console: consoleEvents.length,
          page: pageErrors.length,
          http: httpFailures.length,
        };
        await page.setViewportSize({ width, height });
        const evidenceName = `${surface}-responsive-${width}`;
        const row = {
          surface,
          width,
          height,
          device_scale_factor: surface === "mobile" ? 3 : 1,
          theme: "light",
          reduced_motion: "reduce",
          overflow_px: null,
          screenshot: "",
          errors: [],
          status: "failed",
        };
        try {
          const layout = await page.evaluate(() => ({
            overflow_px: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            viewport_width: window.innerWidth,
            active_theme: getComputedStyle(document.documentElement).colorScheme || "normal",
          }));
          row.overflow_px = layout.overflow_px;
          if (layout.overflow_px > 0) row.errors.push(`horizontal_overflow:${layout.overflow_px}px`);
          const screenshotPath = await screenshot(page, evidenceName, evidence);
          row.screenshot = path.relative(ROOT, screenshotPath);
          for (const event of consoleEvents.slice(eventStart.console)) {
            if (event.page === surface && ["error", "assert"].includes(event.type)) {
              row.errors.push(`console_${event.type}:${event.text}`);
            }
          }
          for (const event of pageErrors.slice(eventStart.page)) {
            if (event.page === surface) row.errors.push(`page_error:${event.message}`);
          }
          for (const event of httpFailures.slice(eventStart.http)) {
            if (event.page === surface) {
              row.errors.push(`http_failure:${event.method}:${event.status ?? "network"}:${event.path}`);
            }
          }
          row.status = row.errors.length === 0 ? "passed" : "failed";
        } catch (error) {
          row.errors.push(String(error?.message || error));
        }
        responsiveChecks.push(row);
        runEvidenceState.responsiveChecks = responsiveChecks;
      }
    }
    assertions.push({
      story_ids: ["US-004", "ES-001"],
      result: "pass",
      evidence: "responsive width sweep",
      widths: viewportWidths,
    });

    await terminalPage.click("#refreshBtn");
    await waitForText(terminalPage, "#invoiceStatusPill", "支払い完了");
    await waitForText(terminalPage, "#operatorGuideList", "商品引渡し: 渡してOK");
    await screenshot(terminalPage, "employee-paid-handoff", evidence);
    assertions.push({ story_ids: ["US-004", "ES-005", "ES-006"], result: "pass", evidence: "employee-paid-handoff" });

    const reviewInvoice = await createInvoice(started.baseUrl, apiSession.token, 1000, fixtureKey("review-invoice"));
    if (reviewInvoice.status !== 201) {
      throw new Error(`review invoice create failed: ${JSON.stringify(reviewInvoice.data)}`);
    }
    await ingestManualPayment(
      started.baseUrl,
      apiSession.token,
      {
        invoice_id: reviewInvoice.data.invoice_id,
        amount_jpyc: 1200,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 3,
        tx_hash: deterministicTxHash("overpay"),
        from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      fixtureKey("overpay")
    );
    await terminalPage.click("#loadReviewsBtn");
    await terminalPage.waitForFunction(() => document.querySelectorAll("#reviewsTable tbody tr").length > 0);
    await terminalPage.click("#reviewsTable tbody tr");
    await waitForText(terminalPage, "#reviewDetailBadge", "未対応");
    const reviewCaseId = String(await terminalPage.locator("#reviewDetailId").innerText()).trim();
    await screenshot(terminalPage, "admin-review-detail", evidence);
    assertions.push({ story_ids: ["US-006", "AS-006", "AS-007"], result: "pass", evidence: "admin-review-detail" });

    await terminalPage.waitForFunction((expectedReviewId) => {
      const review = document.getElementById("refundReviewCaseId");
      const address = document.getElementById("refundAddress");
      return review?.value === expectedReviewId
        && address?.readOnly === true
        && String(address?.value || "").toLowerCase() === "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    }, reviewCaseId);
    await terminalPage.fill("#refundAmount", "200");
    await terminalPage.fill("#refundEvidenceNotePathInput", "output/playwright/story-ui-retest/refund-note.md");
    await terminalPage.fill("#refundCustomerNoteInput", "ローカルUI再テスト用の返金証跡記録。実送金ではありません。");
    await terminalPage.click("#requestRefundBtn");
    await terminalPage.waitForFunction(() => {
      const node = document.getElementById("refundIdInput");
      return Boolean(node && String(node.value || "").trim());
    });
    const refundId = await terminalPage.inputValue("#refundIdInput");
    const approveRefund = await apiRequest(started.baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/approve`, {
      method: "POST",
      headers: authHeaders(approverSession.token, {
        "content-type": "application/json",
        "idempotency-key": fixtureKey("refund-approve"),
      }),
      body: "{}",
    });
    if (approveRefund.status !== 200) {
      throw new Error(`refund approve failed: status=${approveRefund.status} body=${JSON.stringify(approveRefund.data)}`);
    }
    await terminalPage.fill("#refundTxHashInput", deterministicTxHash("refund-execution"));
    await terminalPage.fill("#refundExecutedWalletInput", "0x6666666666666666666666666666666666666666");
    await terminalPage.click("#executeRefundBtn");
    await waitForText(terminalPage, "#executeRefundHint", "もう一度");
    await terminalPage.click("#executeRefundBtn");
    await waitForText(terminalPage, "#executeRefundHint", "返金記録を保存しました");
    await screenshot(terminalPage, "admin-refund-evidence-recorded", evidence);
    assertions.push({ story_ids: ["AS-008"], result: "pass", evidence: "admin-refund-evidence-recorded" });

    const businessDate = new Date().toISOString().slice(0, 10);
    await terminalPage.fill("#businessDateInput", businessDate);
    const previewResponsePromise = terminalPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === "/api/v1/settlements/daily:preview";
    });
    await terminalPage.click("#loadSettlementPreviewBtn");
    const previewResponse = await previewResponsePromise;
    assertUi(previewResponse.ok(), `daily close preview failed with HTTP ${previewResponse.status()}`);
    await terminalPage.waitForFunction(() => {
      const panel = document.getElementById("settlementConfirmPanel");
      const button = document.getElementById("closeSettlementBtn");
      const blockers = String(document.getElementById("settlementPreviewBlockers")?.textContent || "");
      return panel && !panel.classList.contains("hidden") && button?.disabled === true && blockers.trim().length > 0;
    });
    const closeOutcome = await terminalPage.textContent("#settlementPreviewState");
    await screenshot(terminalPage, "admin-settlement-preview-blocked", evidence);
    assertions.push({
      story_ids: ["AS-009", "AS-011", "AS-012", "AS-013"],
      result: "pass",
      evidence: "admin-settlement-preview-blocked",
      note: `Daily close stayed disabled after a blocker-bearing preview: ${String(closeOutcome || "").trim()}`,
    });

    const evidenceSha256 = Object.fromEntries(await Promise.all(evidence.map(async (item) => [
      item.path,
      await sha256File(path.join(ROOT, item.path)),
    ])));
    const sourceCommit = resolveSourceCommit(ROOT);
    if (!sourceCommit) {
      throw new Error("source_commit (git rev-parse HEAD) を解決できなかったため成功証拠を確定できません。");
    }
    const sourceSha256 = await fingerprintRelativeFiles(REQUIRED_UI_SOURCE_FILES);
    const browserIdentityAfter = await captureBrowserBinaryIdentity(browserSelection);
    assertBrowserIdentityUnchanged(browserIdentityBefore, browserIdentityAfter, browser.version());
    runEvidenceState.browserIdentity = browserIdentityAfter;
    await assertEvidenceRunComplete({
      browserStarted: runEvidenceState.browserStarted,
      browserIdentity: browserIdentityAfter,
      expectedWidths: viewportWidths,
      surfaces: ["mobile", "terminal"],
      responsiveChecks,
      evidenceBaseDir: ROOT,
      consoleEvents,
      pageErrors,
      httpFailures,
    });
    if (Object.keys(sourceSha256).length === 0 || Object.keys(evidenceSha256).length === 0) {
      throw new Error("source/evidence hashが空のため成功証拠を確定できません。");
    }
    const manifest = {
      status: "passed",
      exit_code: 0,
      browser_started: true,
      browser_selection: browserSelection,
      browser_identity: browserIdentityAfter,
      responsive_widths: viewportWidths,
      run_started_at: runStartedAtIso,
      generated_at: new Date().toISOString(),
      source_commit: sourceCommit,
      ci: { ...RUN_IDENTITY },
      base_url: started.baseUrl,
      output_dir: path.relative(ROOT, OUT_DIR),
      runtime: {
        node: process.version,
        browser_version: browser.version(),
        browser_identity: browserIdentityAfter,
        browser_selection_source: browserSelection.source,
        desktop_viewport: { width: 1440, height: 960 },
        mobile_viewports: [
          { width: 390, height: 844, device_scale_factor: 3 },
          { width: 375, height: 812, device_scale_factor: 3 },
        ],
        locale: "ja-JP",
        timezone: "Asia/Tokyo",
        theme: "light",
        reduced_motion: "reduce",
        responsive_widths: viewportWidths,
      },
      real_jpyc_used: false,
      real_wallet_used: false,
      production_data_used: false,
      protected_data_modified: false,
      env_boundary: "temporary local DB from tests/helpers/baseServerEnv",
      source_sha256: sourceSha256,
      evidence_sha256: evidenceSha256,
      stories_covered: [...new Set(assertions.flatMap((row) => row.story_ids))].sort(),
      assertions,
      evidence,
      responsive_checks: responsiveChecks,
      console_events: consoleEvents,
      page_errors: pageErrors,
      http_failures: httpFailures,
      http_aborted: httpAborted,
    };
    await writeJson(path.join(OUT_DIR, "manifest.json"), manifest);
    await fs.writeFile(path.join(OUT_DIR, "exit-code.txt"), "0\n", "utf8");
    console.log(JSON.stringify(manifest, null, 2));

  } finally {
    if (browser) {
      await cleanupWithTimeout("browser.close", () => browser.close());
    }
    if (started?.proc) await stopServerProcess(started.proc);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch(async (error) => {
    await writeExitEvidence({
      status: "failed",
      exitCode: 1,
      error,
      details: {
        browser_started: runEvidenceState.browserStarted,
        browser_selection: runEvidenceState.browserSelection,
        browser_identity: runEvidenceState.browserIdentity,
        manifest: {
          failure_mode: error?.code === "BROWSER_SELECTION_REQUIRED"
            ? "explicit_browser_selection_required"
            : error?.code === "EVIDENCE_CI_IDENTITY_INCOMPLETE"
              ? "ci_identity_incomplete"
              : "runtime_failure",
          responsive_widths: runEvidenceState.expectedWidths,
          responsive_checks: runEvidenceState.responsiveChecks,
          console_events: runEvidenceState.consoleEvents,
          page_errors: runEvidenceState.pageErrors,
          http_failures: runEvidenceState.httpFailures,
          http_aborted: runEvidenceState.httpAborted,
        },
      },
    }).catch(() => {});
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
