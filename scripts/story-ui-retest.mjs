import fs from "node:fs/promises";
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
          consoleEvents.push({ page: page === terminalPage ? "terminal" : "mobile", type: msg.type(), text: msg.text() });
        }
      });
      page.on("pageerror", (error) => {
        pageErrors.push({ page: page === terminalPage ? "terminal" : "mobile", message: error.message });
      });
    }

    await terminalPage.goto(`${started.baseUrl}/terminal.html`, { waitUntil: "networkidle" });
    await terminalPage.fill("#terminalCode", env.TERMINAL_CODE);
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

    await mobilePage.goto(paymentUrl, { waitUntil: "networkidle" });
    await mobilePage.waitForSelector("#amountText");
    await screenshot(mobilePage, "user-payment-open", evidence);
    await mobilePage.click("#consentCheckbox");
    await mobilePage.click("#showMethodsBtn");
    await mobilePage.locator("#technicalDetails").evaluate((node) => {
      node.open = true;
      node.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
    await waitForText(mobilePage, "#verifyNetworkText", env.CHAIN_ID);
    await screenshot(mobilePage, "user-consent-manual-payment", evidence);
    assertions.push({ story_ids: ["US-001", "US-002", "US-003", "US-007"], result: "pass", evidence: "user-consent-manual-payment" });

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
    await screenshot(mobilePage, "user-paid-receipt", evidence);
    assertions.push({ story_ids: ["US-004"], result: "pass", evidence: "user-paid-receipt" });

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
    await terminalPage.fill("#refundAddress", "0x4444444444444444444444444444444444444444");
    await terminalPage.fill("#refundChainId", env.CHAIN_ID);
    await terminalPage.fill("#refundEvidenceNotePathInput", "output/playwright/story-ui-retest/refund-note.md");
    await terminalPage.fill("#refundCustomerNoteInput", "ローカルUI再テスト用の返金証跡記録。実送金ではありません。");
    await terminalPage.click("#requestRefundBtn", { force: true });
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
    await terminalPage.click("#executeRefundBtn", { force: true });
    await waitForText(terminalPage, "#executeRefundHint", "もう一度");
    await terminalPage.click("#executeRefundBtn", { force: true });
    await waitForText(terminalPage, "#executeRefundHint", "返金記録を保存しました");
    await screenshot(terminalPage, "admin-refund-evidence-recorded", evidence);
    assertions.push({ story_ids: ["AS-008"], result: "pass", evidence: "admin-refund-evidence-recorded" });

    const businessDate = new Date().toISOString().slice(0, 10);
    await terminalPage.fill("#businessDateInput", businessDate);
    await terminalPage.click("#closeSettlementBtn", { force: true });
    await terminalPage.waitForTimeout(400);
    await terminalPage.click("#closeSettlementBtn", { force: true });
    await terminalPage.waitForTimeout(1000);
    await screenshot(terminalPage, "admin-settlement-expected-block-or-confirmation", evidence);
    assertions.push({
      story_ids: ["AS-009", "AS-011", "AS-012", "AS-013"],
      result: "observed",
      evidence: "admin-settlement-expected-block-or-confirmation",
      note: "Daily close may remain fail-closed while unresolved review/refund evidence exists in the temporary test run.",
    });

    const manifest = {
      generated_at: new Date().toISOString(),
      base_url: started.baseUrl,
      output_dir: path.relative(ROOT, OUT_DIR),
      real_jpyc_used: false,
      real_wallet_used: false,
      production_data_used: false,
      protected_data_modified: false,
      env_boundary: "temporary local DB from tests/helpers/baseServerEnv",
      stories_covered: [...new Set(assertions.flatMap((row) => row.story_ids))].sort(),
      assertions,
      evidence,
      console_events: consoleEvents,
      page_errors: pageErrors,
    };
    await writeJson(path.join(OUT_DIR, "manifest.json"), manifest);
    console.log(JSON.stringify(manifest, null, 2));

    await terminalContext.close();
    await mobileContext.close();
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // no-op
      }
    }
    if (started?.proc) await stopServerProcess(started.proc);
  }
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
