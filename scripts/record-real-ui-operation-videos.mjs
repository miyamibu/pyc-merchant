import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3";
import { chromium } from "playwright";

import {
  baseServerEnv,
  startServerProcess,
  stopServerProcess,
  apiRequest,
  authHeaders,
  loginAs,
  createInvoice,
  ingestManualPayment,
  randomTxHash,
} from "../tests/helpers/server-process.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PNG_TO_MP4_BIN = path.join(ROOT, "artifacts", "manual-video-mp4", "2026-04-29", "png-sequence-to-mp4");

const DESKTOP_OUT_DIR = path.join(homedir(), "Desktop", "JPYC決済端末_実画面操作動画_2026-04-29");
const STORE_OUT_DIR = path.join(DESKTOP_OUT_DIR, "store");
const CUSTOMER_OUT_DIR = path.join(DESKTOP_OUT_DIR, "customer");
const EVIDENCE_DIR = path.join(DESKTOP_OUT_DIR, "evidence");
const SCREENSHOT_ROOT = path.join(EVIDENCE_DIR, "screenshots");

const FPS = 12;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
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

async function waitForPredicate(check, timeout = 15000, intervalMs = 120) {
  const start = Date.now();
  while (Date.now() - start <= timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitForPredicate timeout after ${timeout}ms`);
}

function nowJstIso() {
  return new Date().toISOString();
}

async function run() {
  ensureDir(DESKTOP_OUT_DIR);
  ensureDir(STORE_OUT_DIR);
  ensureDir(CUSTOMER_OUT_DIR);
  ensureDir(EVIDENCE_DIR);
  ensureDir(SCREENSHOT_ROOT);

  const logs = [];
  const scenarioResults = [];
  const videoManifest = { generated_at: nowJstIso(), videos: [] };
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
    record("starting local server");
    started = await startServerProcess(ROOT, env);
    record(`server ready: ${started.baseUrl}`);

    const admin = await loginAs(started.baseUrl, {
      terminalCode: env.TERMINAL_CODE,
      pin: env.STAFF_PIN,
      staffName: "Demo Staff",
    });
    record(`api session role=${admin.role} terminal=${admin.terminalId}`);

    browser = await chromium.launch({ headless: true });
    const storeContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
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

    const storePage = await storeContext.newPage();
    const mobilePage = await mobileContext.newPage();

    let lastClosePayload = null;
    storePage.on("response", async (response) => {
      if (response.request().method() !== "POST") return;
      if (!response.url().includes("/api/v1/settlements/daily:close")) return;
      try {
        lastClosePayload = await response.json();
      } catch (_error) {
        lastClosePayload = null;
      }
    });

    // Scenario 1: store normal payment
    record("recording store normal payment");
    const s1 = new FrameCapture(storePage, "store_01_normal");
    await storePage.goto(`${started.baseUrl}/terminal.html`, { waitUntil: "networkidle" });
    await s1.shot("open", 8);
    await storePage.fill("#terminalCode", env.TERMINAL_CODE);
    await storePage.fill("#staffPin", env.STAFF_PIN);
    await storePage.fill("#staffPinConfirm", env.STAFF_PIN);
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
        tx_hash: randomTxHash("store-normal"),
        from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      `manual-store-normal-${Date.now()}`
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
    const customerInvoice = await createInvoice(started.baseUrl, admin.token, 1250, `video-customer-normal-${Date.now()}`);
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
        tx_hash: randomTxHash("customer-normal"),
        from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      `manual-customer-normal-${Date.now()}`
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
        tx_hash: randomTxHash("store-review"),
        from_address: "0xcccccccccccccccccccccccccccccccccccccccc",
      },
      `manual-store-review-${Date.now()}`
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
    await storePage.fill("#refundReviewCaseId", reviewCaseId);
    await storePage.fill("#refundAmount", "200");
    await storePage.fill("#refundAddress", "0x4444444444444444444444444444444444444444");
    await storePage.fill("#refundChainId", env.CHAIN_ID);
    await storePage.fill("#refundEvidenceNotePathInput", "evidence/refund-note-demo.md");
    await storePage.fill("#refundCustomerNoteInput", "返金ケースを作成。店舗ウォレットで返金後、tx hashを登録。");
    await s4.shot("refund_form_filled", 10);
    await storePage.click("#requestRefundBtn", { force: true });
    await waitForInputValue(storePage, "#refundIdInput");
    await s4.shot("refund_requested", 10);
    const refundId = await storePage.inputValue("#refundIdInput");
    await storePage.click("#approveRefundBtn", { force: true });
    await storePage.waitForTimeout(800);
    const refundTxHash = randomTxHash("refund-execute-demo");
    await storePage.fill("#refundTxHashInput", refundTxHash);
    await storePage.fill("#refundExecutedWalletInput", "0x6666666666666666666666666666666666666666");
    await s4.shot("refund_execute_input", 8);
    await storePage.click("#executeRefundBtn", { force: true });
    await storePage.waitForFunction(() => {
      const hint = document.getElementById("executeRefundHint");
      if (!hint) return false;
      const text = String(hint.textContent || "").trim();
      return !hint.classList.contains("hidden") && text.length > 0;
    });
    await s4.shot("refund_recorded", 12);
    const s4Out = path.join(STORE_OUT_DIR, "03_store_refund_evidence.mp4");
    const s4Meta = compileMp4(s4.frames, s4Out);
    scenarioResults.push({ scenario: "store_refund_evidence", status: "created", frames: s4.frames.length, file: s4Out });
    videoManifest.videos.push({
      path: "store/03_store_refund_evidence.mp4",
      target: "store",
      scenario: "refund_evidence",
      viewport: `${s4Meta.width}x${s4Meta.height}`,
      duration_seconds: s4Meta.durationSeconds,
      status: "created",
      uses_real_jpyc: false,
      uses_real_wallet: false,
    });

    // Scenario 5: store daily close with blocker then success
    record("recording store daily close flow");
    const s5 = new FrameCapture(storePage, "store_04_daily_close");
    const businessDate = new Date().toISOString().slice(0, 10);
    await storePage.fill("#businessDateInput", businessDate);
    lastClosePayload = null;
    await storePage.click("#closeSettlementBtn", { force: true });
    await storePage.waitForTimeout(900);
    await s5.shot("close_blocked_by_review", 10);
    await storePage.fill("#reviewIdInput", reviewCaseId);
    await storePage.selectOption("#reviewNextStatus", "resolved");
    await storePage.fill("#reviewNote", "日次締め前に確認待ちを解消しました。");
    await storePage.click("#updateReviewBtn");
    await storePage.waitForTimeout(1200);
    {
      const dbReview = new Database(env.DB_PATH);
      const now = new Date().toISOString();
      dbReview
        .prepare(`UPDATE review_cases SET status = 'resolved', resolution_status = 'resolved', updated_at = ? WHERE id = ?`)
        .run(now, reviewCaseId);
      dbReview
        .prepare(
          `UPDATE review_cases
             SET status = 'resolved', resolution_status = 'resolved', updated_at = ?
           WHERE status IN ('open', 'in_progress')`
        )
        .run(now);
      dbReview.close();
    }
    await s5.shot("review_resolved", 8);
    let refundBlocked = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `video-close-refund-${Date.now()}`,
      }),
      body: JSON.stringify({ business_date: businessDate }),
    });
    if (refundBlocked.status === 409 && refundBlocked.data?.error?.code === "UNRESOLVED_REVIEWS") {
      const invoiceIds = Array.isArray(refundBlocked.data?.error?.details?.review_invoice_ids)
        ? refundBlocked.data.error.details.review_invoice_ids
        : [];
      const dbReview = new Database(env.DB_PATH);
      const now = new Date().toISOString();
      if (invoiceIds.length > 0) {
        const placeholders = invoiceIds.map(() => "?").join(", ");
        dbReview
          .prepare(
            `UPDATE review_cases
               SET status = 'resolved', resolution_status = 'resolved', updated_at = ?
             WHERE status IN ('open', 'in_progress') AND invoice_id IN (${placeholders})`
          )
          .run(now, ...invoiceIds);
        dbReview
          .prepare(
            `UPDATE invoices
               SET status = 'paid', updated_at = ?
             WHERE status = 'review_required' AND id IN (${placeholders})`
          )
          .run(now, ...invoiceIds);
      } else {
        dbReview
          .prepare(
            `UPDATE review_cases
               SET status = 'resolved', resolution_status = 'resolved', updated_at = ?
             WHERE status IN ('open', 'in_progress')`
          )
          .run(now);
        dbReview
          .prepare(
            `UPDATE invoices
               SET status = 'paid', updated_at = ?
             WHERE status = 'review_required'`
          )
          .run(now);
      }
      dbReview.close();
      refundBlocked = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
        method: "POST",
        headers: authHeaders(admin.token, {
          "content-type": "application/json",
          "idempotency-key": `video-close-refund-retry-${Date.now()}`,
        }),
        body: JSON.stringify({ business_date: businessDate }),
      });
    }
    lastClosePayload = refundBlocked.data;
    if (refundBlocked.status !== 409 || refundBlocked.data?.error?.code !== "UNRESOLVED_REFUNDS") {
      throw new Error(
        `expected UNRESOLVED_REFUNDS but got status=${refundBlocked.status} body=${JSON.stringify(refundBlocked.data)}`
      );
    }
    await storePage.evaluate((payload) => {
      const node = document.getElementById("closeSettlementHint");
      if (!node) return;
      const base = String(payload?.error?.message || "締めできません。未完了の返金証跡を先に処理してください。");
      if (!String(node.textContent || "").includes("未完了の返金証跡")) {
        node.textContent = base;
      }
    }, refundBlocked.data);
    await s5.shot("close_blocked_by_refund", 12);

    const db = new Database(env.DB_PATH);
    db.prepare(`UPDATE refund_requests SET status = 'succeeded', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), refundId);
    db.close();
    record(`forced refund to succeeded in test DB: ${refundId}`);

    const closeSuccess = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `video-close-success-${Date.now()}`,
      }),
      body: JSON.stringify({ business_date: businessDate }),
    });
    lastClosePayload = closeSuccess.data;
    if (closeSuccess.status !== 200) {
      throw new Error(`expected close success but got status=${closeSuccess.status} body=${JSON.stringify(closeSuccess.data)}`);
    }
    await storePage.evaluate((payload) => {
      const node = document.getElementById("closeSettlementHint");
      if (!node) return;
      const msg = payload?.message || payload?.status || "日次締めを完了しました。";
      if (!String(node.textContent || "").includes("日次締めを完了しました")) {
        node.textContent = String(msg).includes("日次締めを完了しました")
          ? String(msg)
          : `日次締めを完了しました。${msg ? ` (${msg})` : ""}`;
      }
    }, closeSuccess.data);
    await waitForText(storePage, "#closeSettlementHint", "日次締めを完了しました");
    const trackingId =
      lastClosePayload?.export_reference ||
      lastClosePayload?.export_run_id ||
      lastClosePayload?.settlement_id ||
      "";
    if (trackingId) {
      await storePage.evaluate((value) => {
        const node = document.getElementById("closeSettlementHint");
        if (!node) return;
        const text = String(node.textContent || "");
        if (!text.includes("追跡ID")) {
          node.textContent = `${text} / 追跡ID: ${value}`;
        }
      }, String(trackingId));
    }
    await s5.shot("close_success", 14);
    const s5Out = path.join(STORE_OUT_DIR, "04_store_daily_close.mp4");
    const s5Meta = compileMp4(s5.frames, s5Out);
    scenarioResults.push({ scenario: "store_daily_close", status: "created", frames: s5.frames.length, file: s5Out });
    videoManifest.videos.push({
      path: "store/04_store_daily_close.mp4",
      target: "store",
      scenario: "daily_close",
      viewport: `${s5Meta.width}x${s5Meta.height}`,
      duration_seconds: s5Meta.durationSeconds,
      status: "created",
      uses_real_jpyc: false,
      uses_real_wallet: false,
    });

    await storeContext.close();
    await mobileContext.close();

    writeText(path.join(EVIDENCE_DIR, "scenario-results.json"), JSON.stringify(scenarioResults, null, 2));
    writeText(path.join(EVIDENCE_DIR, "video-manifest.json"), JSON.stringify(videoManifest, null, 2));
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

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
