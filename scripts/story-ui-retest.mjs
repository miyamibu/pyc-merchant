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
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "../tests/helpers/server-process.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const runStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const OUT_DIR = path.join(ROOT, "output", "playwright", `story-ui-retest-${runStamp}`);
const PLAYWRIGHT_MODULE_CANDIDATES = [
  process.env.PLAYWRIGHT_MODULE_PATH,
  path.join(ROOT, "node_modules", "playwright", "index.mjs"),
  path.join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs"
  ),
].filter(Boolean);
const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);
const SOURCE_FINGERPRINT_FILES = [
  "public/app.css",
  "public/mobile.html",
  "public/mobile.js",
  "public/terminal-entry.html",
  "public/terminal-entry.js",
  "public/terminal.html",
  "public/terminal.js",
  "src/server.mjs",
  "scripts/story-ui-retest.mjs",
  "tests/helpers/server-process.mjs",
];

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
  await ensureDir(OUT_DIR);

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
  let expectedSettlementFailureObserved = false;
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

    const executablePath = await firstExistingPath(CHROME_EXECUTABLE_CANDIDATES);
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const terminalContext = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    const terminalPage = await terminalContext.newPage();
    const mobilePage = await mobileContext.newPage();
    for (const page of [terminalPage, mobilePage]) {
      page.on("console", (msg) => {
        if (["error", "warning"].includes(msg.type())) {
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
    }

    await terminalPage.goto(`${started.baseUrl}/terminal.html`, { waitUntil: "networkidle" });
    await terminalPage.fill("#terminalCode", env.TERMINAL_CODE);
    await terminalPage.fill("#staffName", "Demo Staff");
    await terminalPage.fill("#staffPin", env.STAFF_PIN);
    await terminalPage.fill("#staffPinConfirm", env.STAFF_PIN);
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
        tx_hash: randomTxHash("story-ui-exact"),
        from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      `story-ui-exact-${Date.now()}`
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
    await mobilePage.setViewportSize({ width: 375, height: 812 });
    const mobileOverflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (mobileOverflow > 1) throw new Error(`375px mobile layout overflows horizontally by ${mobileOverflow}px`);
    await screenshot(mobilePage, "user-paid-receipt-375", evidence);
    assertions.push({ story_ids: ["US-004"], result: "pass", evidence: "user-paid-receipt-375" });

    await terminalPage.click("#refreshBtn");
    await waitForText(terminalPage, "#invoiceStatusPill", "支払い完了");
    await waitForText(terminalPage, "#operatorGuideList", "商品引渡し: 渡してOK");
    await screenshot(terminalPage, "employee-paid-handoff", evidence);
    assertions.push({ story_ids: ["US-004", "ES-005", "ES-006"], result: "pass", evidence: "employee-paid-handoff" });

    const reviewInvoice = await createInvoice(started.baseUrl, apiSession.token, 1000, `story-ui-review-${Date.now()}`);
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
        tx_hash: randomTxHash("story-ui-overpay"),
        from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      `story-ui-overpay-${Date.now()}`
    );
    await terminalPage.click("#loadReviewsBtn");
    await terminalPage.waitForFunction(() => document.querySelectorAll("#reviewsTable tbody tr").length > 0);
    await terminalPage.click("#reviewsTable tbody tr");
    await waitForText(terminalPage, "#reviewDetailBadge", "未対応");
    const reviewCaseId = String(await terminalPage.locator("#reviewDetailId").innerText()).trim();
    await screenshot(terminalPage, "admin-review-detail", evidence);
    assertions.push({ story_ids: ["US-006", "AS-006", "AS-007"], result: "pass", evidence: "admin-review-detail" });

    await terminalPage.fill("#refundReviewCaseId", reviewCaseId);
    await terminalPage.fill("#refundAmount", "200");
    await terminalPage.fill("#refundAddress", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await terminalPage.fill("#refundChainId", env.CHAIN_ID);
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
        "idempotency-key": `story-ui-refund-approve-${Date.now()}`,
      }),
      body: "{}",
    });
    if (approveRefund.status !== 200) {
      throw new Error(`refund approve failed: status=${approveRefund.status} body=${JSON.stringify(approveRefund.data)}`);
    }
    await terminalPage.fill("#refundTxHashInput", randomTxHash("story-ui-refund"));
    await terminalPage.fill("#refundExecutedWalletInput", "0x6666666666666666666666666666666666666666");
    await terminalPage.click("#executeRefundBtn");
    await waitForText(terminalPage, "#executeRefundHint", "もう一度");
    await terminalPage.click("#executeRefundBtn");
    await waitForText(terminalPage, "#executeRefundHint", "返金記録を保存しました");
    await screenshot(terminalPage, "admin-refund-evidence-recorded", evidence);
    assertions.push({ story_ids: ["AS-008"], result: "pass", evidence: "admin-refund-evidence-recorded" });

    const businessDate = new Date().toISOString().slice(0, 10);
    await terminalPage.fill("#businessDateInput", businessDate);
    await terminalPage.click("#closeSettlementBtn");
    await terminalPage.waitForTimeout(400);
    const closeResponsePromise = terminalPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.pathname === "/api/v1/settlements/daily:close";
    });
    await terminalPage.click("#closeSettlementBtn");
    const closeResponse = await closeResponsePromise;
    const closeResponseBody = await closeResponse.json().catch(() => ({}));
    if (closeResponse.status() !== 409 || closeResponseBody?.error?.code !== "UNRESOLVED_REVIEWS") {
      throw new Error(
        `daily close did not fail closed with UNRESOLVED_REVIEWS: status=${closeResponse.status()} body=${JSON.stringify(closeResponseBody)}`
      );
    }
    expectedSettlementFailureObserved = true;
    await terminalPage.waitForFunction(() => {
      const text = String(document.getElementById("closeSettlementHint")?.textContent || "");
      return text.includes("unresolved reviews block settlement close")
        || text.includes("未解決レビュー")
        || text.includes("日次締めを停止");
    });
    const closeOutcome = await terminalPage.textContent("#closeSettlementHint");
    if (!String(closeOutcome || "").trim()) throw new Error("daily close did not expose a concrete fail-closed result");
    await screenshot(terminalPage, "admin-settlement-expected-block-or-confirmation", evidence);
    assertions.push({
      story_ids: ["AS-009", "AS-011", "AS-012", "AS-013"],
      result: "pass",
      evidence: "admin-settlement-expected-block-or-confirmation",
      note: `Daily close remained fail-closed with unresolved review evidence: ${String(closeOutcome || "").trim()}`,
    });

    const evidenceSha256 = Object.fromEntries(await Promise.all(evidence.map(async (item) => [
      item.path,
      await sha256File(path.join(ROOT, item.path)),
    ])));
    const isExpectedSettlementConflict = (event) => (
      expectedSettlementFailureObserved
      && event.page === "terminal"
      && event.method === "POST"
      && event.status === 409
      && event.path === "/api/v1/settlements/daily:close"
    );
    const isExpectedSettlementConsoleError = (event) => (
      expectedSettlementFailureObserved
      && event.page === "terminal"
      && /status of 409 \(Conflict\)/.test(event.text)
    );
    const manifest = {
      generated_at: new Date().toISOString(),
      base_url: started.baseUrl,
      output_dir: path.relative(ROOT, OUT_DIR),
      runtime: {
        node: process.version,
        browser: browser.version(),
        desktop_viewport: { width: 1440, height: 960 },
        mobile_viewports: [
          { width: 390, height: 844, device_scale_factor: 3 },
          { width: 375, height: 812, device_scale_factor: 3 },
        ],
        locale: "ja-JP",
        timezone: "Asia/Tokyo",
      },
      real_jpyc_used: false,
      real_wallet_used: false,
      production_data_used: false,
      protected_data_modified: false,
      env_boundary: "temporary local DB from tests/helpers/baseServerEnv",
      source_sha256: await fingerprintRelativeFiles(SOURCE_FINGERPRINT_FILES),
      evidence_sha256: evidenceSha256,
      stories_covered: [...new Set(assertions.flatMap((row) => row.story_ids))].sort(),
      assertions,
      evidence,
      console_events: consoleEvents.map((event) => ({ ...event, expected: isExpectedSettlementConsoleError(event) })),
      page_errors: pageErrors,
      http_failures: httpFailures.map((event) => ({ ...event, expected: isExpectedSettlementConflict(event) })),
    };
    await writeJson(path.join(OUT_DIR, "manifest.json"), manifest);
    console.log(JSON.stringify(manifest, null, 2));

    let expectedConflictConsoleAllowance = expectedSettlementFailureObserved ? 1 : 0;
    const fatalConsoleErrors = consoleEvents.filter((event) => {
      if (event.type !== "error") return false;
      if (
        expectedConflictConsoleAllowance > 0
        && event.page === "terminal"
        && isExpectedSettlementConsoleError(event)
      ) {
        expectedConflictConsoleAllowance -= 1;
        return false;
      }
      return true;
    });
    const fatalHttpFailures = httpFailures.filter((event) => !(
      isExpectedSettlementConflict(event)
    ));
    if (pageErrors.length > 0 || fatalConsoleErrors.length > 0 || fatalHttpFailures.length > 0) {
      throw new Error(
        `browser errors detected: page_errors=${JSON.stringify(pageErrors)} console_errors=${JSON.stringify(fatalConsoleErrors)} http_failures=${JSON.stringify(fatalHttpFailures)}`
      );
    }

  } finally {
    if (browser) {
      await cleanupWithTimeout("browser.close", () => browser.close());
    }
    if (started?.proc) await stopServerProcess(started.proc);
  }
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
