import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  baseServerEnv,
  startServerProcess,
  stopServerProcess,
  loginAs,
  createInvoice,
  ingestManualPayment,
} from "../tests/helpers/server-process.mjs";
import {
  assertBrowserIdentityUnchanged,
  assertEvidenceRunComplete,
  buildUiViewportWidths,
  captureBrowserBinaryIdentity,
  explicitBrowserSelection,
} from "./ui-evidence-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PNG_TO_MP4_BIN = path.join(ROOT, "artifacts", "manual-video-mp4", "2026-04-29", "png-sequence-to-mp4");
const runStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const RUN_OUT_DIR = path.resolve(
  process.env.UI_EVIDENCE_OUTPUT_DIR
    || path.join(ROOT, "output", "playwright", `real-ui-operation-videos-${runStamp}`)
);
const STORE_OUT_DIR = path.join(RUN_OUT_DIR, "store");
const CUSTOMER_OUT_DIR = path.join(RUN_OUT_DIR, "customer");
const EVIDENCE_DIR = path.join(RUN_OUT_DIR, "evidence");
const SCREENSHOT_ROOT = path.join(EVIDENCE_DIR, "screenshots");
const PLAYWRIGHT_MODULE_CANDIDATES = [
  process.env.PLAYWRIGHT_MODULE_PATH,
  path.join(ROOT, "node_modules", "playwright", "index.mjs"),
  path.join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs"
  ),
].filter(Boolean);
const FIXTURE_NAMESPACE = "real-ui-operation-videos-v2";
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

const FPS = 12;

function deterministicTxHash(label) {
  return `0x${createHash("sha256").update(`${FIXTURE_NAMESPACE}:${label}`, "utf8").digest("hex")}`;
}

function fixtureKey(label) {
  return `${FIXTURE_NAMESPACE}:${label}`;
}

async function firstExistingPath(paths) {
  for (const candidate of paths) {
    try {
      await fs.promises.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const modulePath = await firstExistingPath(PLAYWRIGHT_MODULE_CANDIDATES);
    if (!modulePath) {
      throw new Error(
        `playwright package is unavailable. Set PLAYWRIGHT_MODULE_PATH explicitly. Original error: ${error.message}`
      );
    }
    return import(pathToFileURL(modulePath).href);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function writeRunOutcome({ status, exitCode, error = null, manifest = {} }) {
  ensureDir(RUN_OUT_DIR);
  const payload = {
    ...manifest,
    status,
    exit_code: exitCode,
    generated_at: new Date().toISOString(),
    output_dir: path.relative(ROOT, RUN_OUT_DIR),
    browser_started: runEvidenceState.browserStarted,
    browser_selection: runEvidenceState.browserSelection,
    browser_identity: runEvidenceState.browserIdentity,
    responsive_widths: runEvidenceState.expectedWidths,
    responsive_checks: runEvidenceState.responsiveChecks,
    console_events: runEvidenceState.consoleEvents,
    page_errors: runEvidenceState.pageErrors,
    http_failures: runEvidenceState.httpFailures,
    error: error ? {
      code: String(error.code || "UI_VIDEO_EVIDENCE_RUN_FAILED"),
      message: String(error.message || error),
    } : null,
  };
  writeText(path.join(RUN_OUT_DIR, "manifest.json"), `${JSON.stringify(payload, null, 2)}\n`);
  writeText(path.join(RUN_OUT_DIR, "exit-code.txt"), `${exitCode}\n`);
  return payload;
}

function parsePaymentUrlInvoiceId(paymentUrl) {
  const url = new URL(String(paymentUrl || ""));
  const ref = url.searchParams.get("ref");
  if (ref) {
    const decoded = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
    if (decoded?.invoice_id) return String(decoded.invoice_id);
  }
  const direct = url.searchParams.get("invoiceId");
  if (direct) return String(direct);
  return null;
}

function pngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`not a png: ${filePath}`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function compileMp4(framePaths, outputPath) {
  if (!fs.existsSync(PNG_TO_MP4_BIN)) {
    throw new Error(`png-sequence-to-mp4 not found: ${PNG_TO_MP4_BIN}`);
  }
  if (!Array.isArray(framePaths) || framePaths.length === 0) {
    throw new Error(`no frames for ${outputPath}`);
  }
  const { width, height } = pngDimensions(framePaths[0]);
  const args = [outputPath, String(FPS), String(width), String(height), ...framePaths];
  const result = spawnSync(PNG_TO_MP4_BIN, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`mp4 compile failed (${outputPath}): ${result.stderr || result.stdout || "unknown error"}`);
  }
  return { width, height, durationSeconds: Number((framePaths.length / FPS).toFixed(2)) };
}

class FrameCapture {
  constructor(page, scenarioName) {
    this.page = page;
    this.scenarioName = scenarioName;
    this.dir = path.join(SCREENSHOT_ROOT, scenarioName);
    this.frames = [];
    this.index = 0;
    ensureDir(this.dir);
  }

  nextFramePath(label = "frame") {
    const name = `frame_${String(this.index).padStart(5, "0")}_${label}.png`;
    return path.join(this.dir, name);
  }

  async shot(label, hold = 8) {
    const base = this.nextFramePath(label);
    await this.page.screenshot({ path: base });
    this.frames.push(base);
    this.index += 1;
    for (let i = 1; i < hold; i += 1) {
      const dup = this.nextFramePath(label);
      fs.copyFileSync(base, dup);
      this.frames.push(dup);
      this.index += 1;
    }
  }
}

async function captureResponsiveEvidence(page, surface, widths, rows, browserFailures) {
  const targetDir = path.join(EVIDENCE_DIR, "responsive");
  ensureDir(targetDir);
  for (const width of widths) {
    const eventStart = {
      console: browserFailures.consoleEvents.length,
      page: browserFailures.pageErrors.length,
      http: browserFailures.httpFailures.length,
    };
    const height = width <= 430 ? 844 : 960;
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
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => ({
        overflow_px: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        viewport_width: window.innerWidth,
      }));
      row.overflow_px = layout.overflow_px;
      if (layout.overflow_px > 0) row.errors.push(`horizontal_overflow:${layout.overflow_px}px`);
      const screenshotPath = path.join(targetDir, `${surface}-${width}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      row.screenshot = path.relative(ROOT, screenshotPath);
      for (const event of browserFailures.consoleEvents.slice(eventStart.console)) {
        if (event.surface === surface && ["error", "assert"].includes(event.type)) {
          row.errors.push(`console_${event.type}:${event.text}`);
        }
      }
      for (const event of browserFailures.pageErrors.slice(eventStart.page)) {
        if (event.surface === surface) row.errors.push(`page_error:${event.message}`);
      }
      for (const event of browserFailures.httpFailures.slice(eventStart.http)) {
        if (event.surface === surface) {
          row.errors.push(`http_failure:${event.method}:${event.status ?? "network"}:${event.path}`);
        }
      }
      row.status = row.errors.length === 0 ? "passed" : "failed";
    } catch (error) {
      row.errors.push(String(error?.message || error));
    }
    rows.push(row);
    runEvidenceState.responsiveChecks = rows;
  }
}

async function waitForText(page, selector, expectedText, timeout = 15000) {
  await page.waitForFunction(
    ({ sel, text }) => {
      const node = document.querySelector(sel);
      return Boolean(node && String(node.textContent || "").includes(text));
    },
    { sel: selector, text: expectedText },
    { timeout }
  );
}

async function waitForInputValue(page, selector, timeout = 15000) {
  await page.waitForFunction(
    ({ sel }) => {
      const node = document.querySelector(sel);
      return Boolean(node && "value" in node && String(node.value || "").trim().length > 0);
    },
    { sel: selector },
    { timeout }
  );
}

function nowJstIso() {
  return new Date().toISOString();
}

async function run() {
  ensureDir(RUN_OUT_DIR);
  ensureDir(STORE_OUT_DIR);
  ensureDir(CUSTOMER_OUT_DIR);
  ensureDir(EVIDENCE_DIR);
  ensureDir(SCREENSHOT_ROOT);

  const browserSelection = explicitBrowserSelection(process.argv.slice(2), process.env);
  runEvidenceState.browserSelection = browserSelection;
  const browserIdentityBefore = await captureBrowserBinaryIdentity(browserSelection);
  runEvidenceState.browserIdentity = browserIdentityBefore;
  const cssText = fs.readFileSync(path.join(ROOT, "public", "app.css"), "utf8");
  const viewportWidths = buildUiViewportWidths(cssText);
  runEvidenceState.expectedWidths = viewportWidths;

  const logs = [];
  const scenarioResults = [];
  const responsiveChecks = [];
  const consoleEvents = [];
  const pageErrors = [];
  const httpFailures = [];
  runEvidenceState.consoleEvents = consoleEvents;
  runEvidenceState.pageErrors = pageErrors;
  runEvidenceState.httpFailures = httpFailures;
  const videoManifest = {
    status: "running",
    generated_at: nowJstIso(),
    videos: [],
    responsive_widths: viewportWidths,
  };
  const record = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logs.push(line);
    console.log(line);
  };

  const env = baseServerEnv({
    TERMINAL_CODE: "TERM-VAL-01",
    STAFF_PIN: "2468",
    SECOND_ADMIN_PIN: "8642",
    ALLOW_MANUAL_PAYMENT_INGEST: "true",
    SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS: "true",
    SETTLEMENT_UNRESOLVED_REVIEW_POLICY: "block",
    WALLET_ADAPTER_TYPE: "mock",
    ENABLE_REOWN: "false",
  });
  env.CORS_ALLOW_ORIGINS = [env.APP_HOST, "http://localhost:4173", "http://127.0.0.1:4173"].join(",");

  let started = null;
  let browser = null;

  try {
    const { chromium } = await loadPlaywright();
    record("starting local server");
    started = await startServerProcess(ROOT, env);
    record(`server ready: ${started.baseUrl}`);

    const admin = await loginAs(started.baseUrl, {
      terminalCode: env.TERMINAL_CODE,
      pin: env.STAFF_PIN,
      staffName: "Demo Staff",
    });
    record(`api session role=${admin.role} terminal=${admin.terminalId}`);

    browser = await chromium.launch({
      headless: true,
      executablePath: browserSelection.executablePath,
    });
    runEvidenceState.browserStarted = true;
    const storeContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      colorScheme: "light",
      reducedMotion: "reduce",
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

    const storePage = await storeContext.newPage();
    const mobilePage = await mobileContext.newPage();
    for (const [surface, page] of [["terminal", storePage], ["mobile", mobilePage]]) {
      page.on("console", (message) => {
        if (["error", "warning", "assert"].includes(message.type())) {
          consoleEvents.push({ surface, type: message.type(), text: message.text(), location: message.location() });
        }
      });
      page.on("pageerror", (error) => pageErrors.push({ surface, message: error.message }));
      page.on("response", (response) => {
        if (response.status() < 400) return;
        const url = new URL(response.url());
        httpFailures.push({
          surface,
          method: response.request().method(),
          status: response.status(),
          path: `${url.pathname}${url.search}`,
        });
      });
      page.on("requestfailed", (request) => {
        const url = new URL(request.url());
        httpFailures.push({
          surface,
          method: request.method(),
          status: null,
          path: `${url.pathname}${url.search}`,
          failure: request.failure()?.errorText || "request_failed",
        });
      });
    }

    // Scenario 1: store normal payment
    record("recording store normal payment");
    const s1 = new FrameCapture(storePage, "store_01_normal");
    await storePage.goto(`${started.baseUrl}/terminal.html`, { waitUntil: "networkidle" });
    await s1.shot("open", 8);
    await storePage.fill("#terminalCode", env.TERMINAL_CODE);
    await storePage.fill("#staffName", "Demo Staff");
    await storePage.fill("#staffPin", env.STAFF_PIN);
    await s1.shot("filled_credentials", 6);
    await storePage.click("#loginBtn");
    await storePage.waitForFunction(() => {
      const n = document.getElementById("sessionText");
      return n && String(n.textContent || "").trim() !== "未接続";
    });
    await storePage.waitForTimeout(700);
    await s1.shot("logged_in", 8);
    await storePage.fill("#amountInput", "1250");
    await s1.shot("amount_ready", 6);
    await storePage.click("#createInvoiceBtn");
    await storePage.waitForFunction(() => {
      const n = document.getElementById("invoiceIdText");
      return n && String(n.textContent || "").trim() !== "-";
    });
    await waitForText(storePage, "#operatorGuideList", "商品引渡し: まだ渡さない");
    await s1.shot("invoice_created_waiting", 14);
    const storePaymentUrl = await storePage.getAttribute("#paymentUrlLink", "href");
    const storeInvoiceId = parsePaymentUrlInvoiceId(storePaymentUrl);
    if (!storeInvoiceId) throw new Error("failed to parse store invoice id from payment URL");
    await ingestManualPayment(
      started.baseUrl,
      admin.token,
      {
        invoice_id: storeInvoiceId,
        amount_jpyc: 1250,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 3,
        tx_hash: deterministicTxHash("store-normal"),
        from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      fixtureKey("store-normal")
    );
    await storePage.click("#refreshBtn");
    await waitForText(storePage, "#invoiceStatusPill", "支払い完了");
    await waitForText(storePage, "#operatorGuideList", "商品引渡し: 渡してOK");
    await s1.shot("paid", 16);
    const s1Out = path.join(STORE_OUT_DIR, "01_store_normal_payment.mp4");
    const s1Meta = compileMp4(s1.frames, s1Out);
    scenarioResults.push({ scenario: "store_normal_payment", status: "created", frames: s1.frames.length, file: s1Out });
    videoManifest.videos.push({
      path: "store/01_store_normal_payment.mp4",
      target: "store",
      scenario: "normal_payment",
      viewport: `${s1Meta.width}x${s1Meta.height}`,
      duration_seconds: s1Meta.durationSeconds,
      status: "created",
      uses_real_jpyc: false,
      uses_real_wallet: false,
    });

    // Scenario 2: customer normal mobile payment
    record("recording customer normal payment");
    const customerInvoice = await createInvoice(started.baseUrl, admin.token, 1250, fixtureKey("customer-normal-invoice"));
    if (customerInvoice.status !== 201) {
      throw new Error(`customer invoice create failed: ${JSON.stringify(customerInvoice.data)}`);
    }
    const customerInvoiceId = customerInvoice.data.invoice_id;
    const customerPaymentUrl = customerInvoice.data.payment_url;
    const s2 = new FrameCapture(mobilePage, "customer_01_normal_mobile");
    await mobilePage.goto(customerPaymentUrl, { waitUntil: "networkidle" });
    await mobilePage.waitForSelector("#amountText");
    await mobilePage.waitForTimeout(1000);
    await s2.shot("open", 10);
    await mobilePage.waitForFunction(() => {
      const gate = document.getElementById("consentGateSection");
      return gate && !gate.classList.contains("hidden");
    });
    await mobilePage.click("#consentCheckbox");
    await mobilePage.waitForTimeout(500);
    await s2.shot("consented", 8);
    await mobilePage.click("#showMethodsBtn");
    await mobilePage.waitForTimeout(600);
    await s2.shot("methods", 8);
    await mobilePage.locator("#technicalDetails summary").click();
    await mobilePage.waitForTimeout(500);
    await s2.shot("details_open", 10);
    await mobilePage.click("#copyInfoBtn");
    await mobilePage.waitForTimeout(400);
    await s2.shot("copy_info", 8);
    await ingestManualPayment(
      started.baseUrl,
      admin.token,
      {
        invoice_id: customerInvoiceId,
        amount_jpyc: 1250,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 3,
        tx_hash: deterministicTxHash("customer-normal"),
        from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      fixtureKey("customer-normal-payment")
    );
    await mobilePage.click("#refreshBtn", { force: true });
    await waitForText(mobilePage, "#statusPill", "支払い確認済み");
    await s2.shot("paid", 14);
    const s2Out = path.join(CUSTOMER_OUT_DIR, "01_customer_normal_payment_mobile.mp4");
    const s2Meta = compileMp4(s2.frames, s2Out);
    scenarioResults.push({ scenario: "customer_normal_payment_mobile", status: "created", frames: s2.frames.length, file: s2Out });
    videoManifest.videos.push({
      path: "customer/01_customer_normal_payment_mobile.mp4",
      target: "customer",
      scenario: "normal_payment_mobile",
      viewport: `${s2Meta.width}x${s2Meta.height}`,
      duration_seconds: s2Meta.durationSeconds,
      status: "created",
      uses_real_jpyc: false,
      uses_real_wallet: false,
    });

    // Scenario 3: store review-needed flow
    record("recording store review-needed flow");
    const s3 = new FrameCapture(storePage, "store_02_review_needed");
    await storePage.fill("#amountInput", "1000");
    await s3.shot("review_amount_ready", 6);
    await storePage.click("#createInvoiceBtn");
    await storePage.waitForTimeout(800);
    const reviewPaymentUrl = await storePage.getAttribute("#paymentUrlLink", "href");
    const reviewInvoiceId = parsePaymentUrlInvoiceId(reviewPaymentUrl);
    if (!reviewInvoiceId) throw new Error("failed to parse review invoice id");
    await ingestManualPayment(
      started.baseUrl,
      admin.token,
      {
        invoice_id: reviewInvoiceId,
        amount_jpyc: 1200,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 3,
        tx_hash: deterministicTxHash("store-review"),
        from_address: "0xcccccccccccccccccccccccccccccccccccccccc",
      },
      fixtureKey("store-review")
    );
    await storePage.click("#refreshBtn");
    await waitForText(storePage, "#operatorGuideHeadline", "店長確認が必要");
    await s3.shot("review_needed", 12);
    await storePage.click("#loadReviewsBtn");
    await storePage.waitForFunction(() => {
      const rows = document.querySelectorAll("#reviewsTable tbody tr");
      return rows.length > 0;
    });
    await storePage.click("#reviewsTable tbody tr");
    await waitForText(storePage, "#reviewDetailBadge", "未対応");
    await storePage.fill("#reviewNote", "追加送金させない。管理者を呼ぶ。");
    await s3.shot("review_detail", 12);
    const reviewCaseId = String(await storePage.locator("#reviewDetailId").innerText()).trim();
    const s3Out = path.join(STORE_OUT_DIR, "02_store_review_needed.mp4");
    const s3Meta = compileMp4(s3.frames, s3Out);
    scenarioResults.push({ scenario: "store_review_needed", status: "created", frames: s3.frames.length, file: s3Out });
    videoManifest.videos.push({
      path: "store/02_store_review_needed.mp4",
      target: "store",
      scenario: "review_needed",
      viewport: `${s3Meta.width}x${s3Meta.height}`,
      duration_seconds: s3Meta.durationSeconds,
      status: "created",
      uses_real_jpyc: false,
      uses_real_wallet: false,
    });

    // Scenario 4: store refund evidence flow
    record("recording store refund evidence flow");
    const s4 = new FrameCapture(storePage, "store_03_refund_evidence");
    await storePage.waitForFunction((expectedReviewId) => {
      const review = document.getElementById("refundReviewCaseId");
      const address = document.getElementById("refundAddress");
      return review?.value === expectedReviewId
        && address?.readOnly === true
        && String(address?.value || "").toLowerCase() === "0xcccccccccccccccccccccccccccccccccccccccc";
    }, reviewCaseId);
    await storePage.fill("#refundAmount", "200");
    await storePage.fill("#refundEvidenceNotePathInput", "evidence/refund-note-demo.md");
    await storePage.fill("#refundCustomerNoteInput", "返金ケースを作成。店舗ウォレットで返金後、tx hashを登録。");
    await s4.shot("refund_form_filled", 10);
    await storePage.click("#requestRefundBtn", { force: true });
    await waitForInputValue(storePage, "#refundIdInput");
    await s4.shot("refund_requested", 10);
    await waitForText(storePage, "#refundStepApproveBadge", "承認待ち");
    await s4.shot("refund_pending_separate_approval", 12);
    const s4Out = path.join(STORE_OUT_DIR, "03_store_refund_evidence.mp4");
    const s4Meta = compileMp4(s4.frames, s4Out);
    scenarioResults.push({ scenario: "store_refund_evidence", status: "created", frames: s4.frames.length, file: s4Out });
    videoManifest.videos.push({
      path: "store/03_store_refund_evidence.mp4",
      target: "store",
      scenario: "refund_pending_separate_approval",
      viewport: `${s4Meta.width}x${s4Meta.height}`,
      duration_seconds: s4Meta.durationSeconds,
      status: "created",
      uses_real_jpyc: false,
      uses_real_wallet: false,
    });

    // Scenario 5: daily close preview remains blocked while unresolved work exists.
    record("recording store daily close flow");
    const s5 = new FrameCapture(storePage, "store_04_daily_close");
    const businessDate = new Date().toISOString().slice(0, 10);
    await storePage.fill("#businessDateInput", businessDate);
    const previewResponsePromise = storePage.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === "/api/v1/settlements/daily:preview";
    });
    await storePage.click("#loadSettlementPreviewBtn");
    const previewResponse = await previewResponsePromise;
    if (!previewResponse.ok()) throw new Error(`daily close preview failed with HTTP ${previewResponse.status()}`);
    await storePage.waitForFunction(() => {
      const panel = document.getElementById("settlementConfirmPanel");
      const close = document.getElementById("closeSettlementBtn");
      const blockers = String(document.getElementById("settlementPreviewBlockers")?.textContent || "");
      return panel && !panel.classList.contains("hidden") && close?.disabled === true && blockers.trim().length > 0;
    });
    await s5.shot("close_preview_blocked", 14);
    const s5Out = path.join(STORE_OUT_DIR, "04_store_daily_close.mp4");
    const s5Meta = compileMp4(s5.frames, s5Out);
    scenarioResults.push({ scenario: "store_daily_close", status: "created", frames: s5.frames.length, file: s5Out });
    videoManifest.videos.push({
      path: "store/04_store_daily_close.mp4",
      target: "store",
      scenario: "daily_close_preview_blocked",
      viewport: `${s5Meta.width}x${s5Meta.height}`,
      duration_seconds: s5Meta.durationSeconds,
      status: "created",
      uses_real_jpyc: false,
      uses_real_wallet: false,
    });

    const browserFailures = { consoleEvents, pageErrors, httpFailures };
    await captureResponsiveEvidence(storePage, "terminal", viewportWidths, responsiveChecks, browserFailures);
    await captureResponsiveEvidence(mobilePage, "mobile", viewportWidths, responsiveChecks, browserFailures);

    const browserIdentityAfter = await captureBrowserBinaryIdentity(browserSelection);
    assertBrowserIdentityUnchanged(browserIdentityBefore, browserIdentityAfter, browser.version());
    runEvidenceState.browserIdentity = browserIdentityAfter;
    await assertEvidenceRunComplete({
      browserStarted: runEvidenceState.browserStarted,
      browserIdentity: browserIdentityAfter,
      expectedWidths: viewportWidths,
      surfaces: ["terminal", "mobile"],
      responsiveChecks,
      evidenceBaseDir: ROOT,
      consoleEvents,
      pageErrors,
      httpFailures,
    });

    videoManifest.status = "passed";
    videoManifest.browser_identity = browserIdentityAfter;
    videoManifest.browser_version = browser.version();
    videoManifest.browser_selection_source = browserSelection.source;
    videoManifest.responsive_checks = responsiveChecks;
    videoManifest.console_events = consoleEvents;
    videoManifest.page_errors = pageErrors;
    videoManifest.http_failures = httpFailures;

    writeText(path.join(EVIDENCE_DIR, "scenario-results.json"), JSON.stringify(scenarioResults, null, 2));
    writeText(path.join(EVIDENCE_DIR, "video-manifest.json"), `${JSON.stringify(videoManifest, null, 2)}\n`);
    writeText(
      path.join(EVIDENCE_DIR, "app-env-sanitized.txt"),
      [
        `app_mode: ${env.APP_ENV}`,
        `base_url: ${started.baseUrl}`,
        `db_path: ${env.DB_PATH} (temporary test DB)`,
        `wallet_adapter: ${env.WALLET_ADAPTER_TYPE}`,
        `real_payment_mode: disabled`,
        `uses_real_jpyc: false`,
        `uses_real_wallet: false`,
        "secrets: redacted",
      ].join("\n")
    );

    logs.push(`${nowJstIso()} created_files:`);
    for (const row of videoManifest.videos) logs.push(`- ${row.path}`);
    writeText(path.join(EVIDENCE_DIR, "run-log.txt"), logs.join("\n") + "\n");
    const manifest = writeRunOutcome({
      status: "passed",
      exitCode: 0,
      manifest: {
        base_url: started.baseUrl,
        runtime: {
          node: process.version,
          browser_version: browser.version(),
          browser_identity: browserIdentityAfter,
          browser_selection_source: browserSelection.source,
          locale: "ja-JP",
          timezone: "Asia/Tokyo",
          theme: "light",
          reduced_motion: "reduce",
          device_scale_factors: { terminal: 1, mobile: 3 },
        },
        fixture_namespace: FIXTURE_NAMESPACE,
        deterministic_local_fixture: true,
        real_jpyc_used: false,
        real_wallet_used: false,
        production_data_used: false,
        protected_data_modified: false,
        scenarios: scenarioResults,
        videos: videoManifest.videos,
        console_events: consoleEvents,
        page_errors: pageErrors,
        http_failures: httpFailures,
      },
    });
    await storeContext.close();
    await mobileContext.close();
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_error) {
        // no-op
      }
    }
    if (started?.proc) {
      await stopServerProcess(started.proc);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((error) => {
    try {
      writeRunOutcome({
        status: "failed",
        exitCode: 1,
        error,
        manifest: {
          failure_mode: error?.code === "BROWSER_SELECTION_REQUIRED"
            ? "explicit_browser_selection_required"
            : "runtime_failure",
        },
      });
    } catch {
      // The original failure remains authoritative when even failure evidence cannot be written.
    }
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
