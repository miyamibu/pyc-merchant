import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:4173";
const TERMINAL_CODE = process.env.TERMINAL_CODE || "TERM-001";
const STAFF_PIN = process.env.STAFF_PIN || "1234";
const SECOND_ADMIN_PIN = process.env.SECOND_ADMIN_PIN || "5678";
const SECOND_ADMIN_STAFF_NAME = "Demo Approver";
const CHAIN_ID = process.env.CHAIN_ID || "137";
const TOKEN_CONTRACT = process.env.TOKEN_CONTRACT || "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
const RECIPIENT = process.env.RECIPIENT_ADDRESS || "0x2222222222222222222222222222222222222222";
const CUSTOMER_ADDRESS = process.env.CUSTOMER_ADDRESS || "0x3333333333333333333333333333333333333333";
const SERVICE_INGEST_ID = process.env.SERVICE_INGEST_ID || "chain-monitor";
const SERVICE_INGEST_SECRET = process.env.SERVICE_INGEST_SECRET || "replace-with-very-long-random-ingest-secret";
const SESSION_EXPIRE_WAIT_MS = Number(process.env.SESSION_EXPIRE_WAIT_MS || 0);
const SMOKE_AUTO_START = String(process.env.SMOKE_AUTO_START || "true").toLowerCase() !== "false";
const SMOKE_REUSE_EXISTING = String(process.env.SMOKE_REUSE_EXISTING || "false").toLowerCase() === "true";
let ACTIVE_BASE_URL = BASE_URL;

async function request(path, options = {}) {
  const response = await fetch(`${ACTIVE_BASE_URL}${path}`, options);
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { status: response.status, data };
}

async function canReachHealth(targetBaseUrl = ACTIVE_BASE_URL) {
  try {
    const response = await fetch(`${targetBaseUrl}/healthz`);
    return response.ok;
  } catch (_error) {
    return false;
  }
}

function buildServerEnv(targetBaseUrl) {
  const url = new URL(targetBaseUrl);
  const env = { ...process.env };
  const smokeRoot = env.SMOKE_RUNTIME_DIR || mkdtempSync(path.join(tmpdir(), "jpyc-smoke-"));
  env.APP_PORT = env.APP_PORT || (url.port || "4173");
  env.APP_HOST = env.APP_HOST || targetBaseUrl;
  env.APP_BIND_HOST = env.APP_BIND_HOST || (["localhost", "127.0.0.1", "::1"].includes(url.hostname) ? url.hostname : "127.0.0.1");
  env.DB_PATH = env.DB_PATH || path.join(smokeRoot, "app.db");
  env.BACKUP_DIR = env.BACKUP_DIR || path.join(smokeRoot, "backups");
  mkdirSync(path.dirname(path.resolve(process.cwd(), env.DB_PATH)), { recursive: true });
  mkdirSync(path.resolve(process.cwd(), env.BACKUP_DIR), { recursive: true });
  env.APP_SECRET = env.APP_SECRET || crypto.randomBytes(32).toString("hex");
  env.SERVICE_INGEST_SECRET = env.SERVICE_INGEST_SECRET || SERVICE_INGEST_SECRET;
  env.METRICS_SECRET = env.METRICS_SECRET || crypto.randomBytes(32).toString("hex");
  env.TERMINAL_CODE = env.TERMINAL_CODE || TERMINAL_CODE;
  env.STAFF_PIN = env.STAFF_PIN || STAFF_PIN;
  env.SECOND_ADMIN_PIN = env.SECOND_ADMIN_PIN || SECOND_ADMIN_PIN;
  env.CHAIN_ID = env.CHAIN_ID || CHAIN_ID;
  env.ENABLED_PAYMENT_CHAIN_IDS = env.ENABLED_PAYMENT_CHAIN_IDS || "1,43114,137";
  env.TOKEN_CONTRACT = env.TOKEN_CONTRACT || TOKEN_CONTRACT;
  env.APPROVED_JPYC_TOKEN_CONTRACT = env.APPROVED_JPYC_TOKEN_CONTRACT || TOKEN_CONTRACT;
  env.JPYC_CONTRACT_APPROVAL_REF = env.JPYC_CONTRACT_APPROVAL_REF || "SMOKE-JPYC-CONTRACT-001";
  env.RECIPIENT_ADDRESS = env.RECIPIENT_ADDRESS || RECIPIENT;
  env.TOKEN_DECIMALS = env.TOKEN_DECIMALS || "18";
  env.LEDGER_DECIMALS = env.LEDGER_DECIMALS || "6";
  env.LEDGER_BASE_UNIT_SCALE = env.LEDGER_BASE_UNIT_SCALE || env.JPYC_BASE_UNIT_SCALE || "1000000";
  env.RECEIVE_ADDRESS_DEV_AUTO_VERIFY = env.RECEIVE_ADDRESS_DEV_AUTO_VERIFY || "true";
  env.REQUIRED_CONFIRMATIONS = env.REQUIRED_CONFIRMATIONS || "2";
  env.MIN_REQUIRED_CONFIRMATIONS = env.MIN_REQUIRED_CONFIRMATIONS || "2";
  env.MAX_ACTIVE_INVOICES_PER_RECIPIENT = env.MAX_ACTIVE_INVOICES_PER_RECIPIENT || "50";
  return env;
}

async function waitForServerReady(proc, logs, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (proc.exitCode != null) {
      throw new Error(`auto-started server exited early (code=${proc.exitCode})\n${logs.join("")}`);
    }
    if (await canReachHealth()) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`auto-started server not ready within ${timeoutMs}ms\n${logs.join("")}`);
}

async function ensureServer() {
  if (await canReachHealth(ACTIVE_BASE_URL)) {
    if (SMOKE_REUSE_EXISTING || !SMOKE_AUTO_START) return null;
    const isolatedPort = 46000 + Math.floor(Math.random() * 10000);
    ACTIVE_BASE_URL = `http://127.0.0.1:${isolatedPort}`;
  }
  if (await canReachHealth(ACTIVE_BASE_URL)) return null;
  if (!SMOKE_AUTO_START) {
    throw new Error("target server is not reachable and SMOKE_AUTO_START=false");
  }
  const logs = [];
  const proc = spawn("node", ["src/server.mjs"], {
    cwd: process.cwd(),
    env: buildServerEnv(ACTIVE_BASE_URL),
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => logs.push(String(chunk)));
  proc.stderr.on("data", (chunk) => logs.push(String(chunk)));
  await waitForServerReady(proc, logs);
  return { proc, logs };
}

async function stopServer(handle) {
  if (!handle?.proc || handle.proc.exitCode != null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        handle.proc.kill("SIGKILL");
      } catch (_error) {
        // no-op
      }
      resolve();
    }, 3000);
    handle.proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    handle.proc.kill("SIGTERM");
  });
}

function assert(condition, message, payload) {
  if (condition) return;
  const error = new Error(message);
  error.payload = payload;
  throw error;
}

function createNonce() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function businessDateForStoreTimezone(date, timeZone) {
  const instant = date instanceof Date ? date : new Date(date);
  const zone = String(timeZone || "").trim();
  if (!zone || !Number.isFinite(instant.getTime())) throw new Error("invalid store timezone or date");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function randomTxHash(seed = "") {
  const value = `${seed}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const hex = Buffer.from(value).toString("hex").slice(0, 64).padEnd(64, "0");
  return `0x${hex}`;
}

function parseInvoiceLink(paymentUrl) {
  const url = new URL(paymentUrl);
  const ref = url.searchParams.get("ref");
  if (ref) {
    try {
      const raw = Buffer.from(ref, "base64url").toString("utf8");
      const payload = JSON.parse(raw);
      return {
        invoiceId: payload.invoice_id || null,
        sig: payload.sig || null,
        exp: String(payload.exp || ""),
        nonce: payload.nonce || null
      };
    } catch {
      // fall through
    }
  }
  return {
    invoiceId: url.searchParams.get("invoiceId"),
    sig: url.searchParams.get("sig"),
    exp: url.searchParams.get("exp"),
    nonce: url.searchParams.get("nonce")
  };
}

async function loginTerminal() {
  return loginAs(STAFF_PIN);
}

async function loginAs(staffPin, staffName = null) {
  const login = await request("/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalCode: TERMINAL_CODE, staffPin: staffPin, staffName: staffName || undefined })
  });
  assert(login.status === 201, "terminal login failed", login);
  return {
    authorization: `Bearer ${login.data.token}`,
    login
  };
}

function createServiceHeaders(payload, options = {}) {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const jti = options.jti || crypto.randomUUID();
  const payloadHash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  let signature = crypto.createHmac("sha256", SERVICE_INGEST_SECRET).update(`${SERVICE_INGEST_ID}.${timestamp}.${jti}.${payloadHash}`).digest("hex");
  if (options.mismatchSignature) {
    signature = signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");
  }
  return {
    "content-type": "application/json",
    "idempotency-key": options.idempotencyKey || `svc-${createNonce()}`,
    "x-service-id": SERVICE_INGEST_ID,
    "x-service-timestamp": String(timestamp),
    "x-service-jti": jti,
    "x-service-signature": signature
  };
}

async function createInvoice(authorization, idempotencyKey, amountJpy) {
  const created = await request("/api/v1/invoices", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify({
      amount_jpy: amountJpy,
      payment_chain_id: CHAIN_ID
    })
  });
  assert(created.status === 201, "invoice creation failed", created);
  const parsed = parseInvoiceLink(created.data.payment_url);
  assert(parsed.invoiceId && parsed.sig && parsed.exp && parsed.nonce, "invalid signed payment_url", created);
  return parsed;
}

async function ingestPayment(authorization, idempotencyKey, link, amountJpyc, mode = "exact") {
  const chainId = mode === "wrong_chain" ? "1" : CHAIN_ID;
  const tokenContract = mode === "wrong_token" ? "0xdeadbeef" : TOKEN_CONTRACT;
  const amount = mode === "overpay" ? amountJpyc + 200 : amountJpyc;
  const observedAt = new Date().toISOString();
  return request("/api/v1/payments/events:ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify({
      invoice_id: link.invoiceId,
      amount_jpyc: amount,
      chain_id: chainId,
      token_contract: tokenContract,
      to_address: RECIPIENT,
      confirmations: 2,
      log_index: 0,
      block_number: 123,
      block_hash: `0x${"b".repeat(64)}`,
      block_timestamp: observedAt,
      detected_at: observedAt,
      canonical_status: "canonical",
      tx_hash: randomTxHash(`${mode}-${link.invoiceId}`),
      from_address: CUSTOMER_ADDRESS
    })
  });
}

async function getInvoiceStatus(authorization, invoiceId) {
  return request(`/api/v1/invoices/${invoiceId}`, {
    headers: { authorization }
  });
}

async function main() {
  const autoServer = await ensureServer();
  const nonce = createNonce();
  const summary = {};
  try {
    const health = await request("/healthz");
    assert(health.status === 200, "health endpoint failed", health);
    summary.health = health.data;

    const corsRejected = await request("/healthz", {
      headers: { origin: "https://evil.example" }
    });
    assert(corsRejected.status === 403, "CORS rejection test failed", corsRejected);
    summary.cors = { rejectedStatus: corsRejected.status };

    const initialLogin = await loginTerminal();
    let authorization = initialLogin.authorization;
    let approverAuthorization = authorization;
    summary.login = {
      status: initialLogin.login.status,
      role: initialLogin.login.data.role,
      terminalId: initialLogin.login.data.terminalId
    };

  const rejectedAdminCreation = await request("/api/v1/staff", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-reject-admin-create-${nonce}`
    },
    body: JSON.stringify({
      staff_name: `Smoke Admin Candidate ${nonce}`,
      role: "admin",
      pin: "7789",
      status: "active"
    })
  });
  assert(rejectedAdminCreation.status === 403, "direct admin staff creation should be rejected", rejectedAdminCreation);
  assert(
    rejectedAdminCreation.data?.error?.code === "STAFF_SECURITY_APPROVAL_REQUIRED",
    "direct admin staff creation returned the wrong rejection code",
    rejectedAdminCreation,
  );

  const allowedStaffCreation = await request("/api/v1/staff", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-allow-staff-create-${nonce}`
    },
    body: JSON.stringify({
      staff_name: `Smoke Staff ${nonce}`,
      role: "staff",
      pin: "7788",
      status: "active"
    })
  });
  assert(allowedStaffCreation.status === 201, "direct creation of an allowed staff role failed", allowedStaffCreation);
  assert(allowedStaffCreation.data?.staff?.role === "staff", "allowed staff role creation returned the wrong role", allowedStaffCreation);

  const approverLogin = await loginAs(SECOND_ADMIN_PIN, SECOND_ADMIN_STAFF_NAME);
  approverAuthorization = approverLogin.authorization;
  summary.approver = {
    staffName: approverLogin.login.data.staff_name,
    role: approverLogin.login.data.role,
    terminalId: approverLogin.login.data.terminalId
  };
  summary.staffSecurity = {
    directAdminCreateStatus: rejectedAdminCreation.status,
    directAdminCreateCode: rejectedAdminCreation.data?.error?.code,
    allowedRole: allowedStaffCreation.data.staff.role,
    allowedRoleCreateStatus: allowedStaffCreation.status,
  };

  const internalIngestWithoutSignature = await request("/api/v1/internal/payments/events:ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `smoke-internal-ingest-unauth-${nonce}`
    },
    body: JSON.stringify({
      invoice_id: "dummy",
      amount_jpyc: 1,
      chain_id: CHAIN_ID,
      token_contract: TOKEN_CONTRACT,
      to_address: RECIPIENT,
      tx_hash: randomTxHash("internal-unauth")
    })
  });
  assert(internalIngestWithoutSignature.status === 401, "internal ingest must require service signature", internalIngestWithoutSignature);
  summary.internalIngestAuth = { missingSignatureStatus: internalIngestWithoutSignature.status };

  const missingIdem = await request("/api/v1/invoices", {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ amount_jpy: 100, payment_chain_id: CHAIN_ID })
  });
  assert(missingIdem.status === 400, "idempotency validation failed", missingIdem);
  summary.idempotency = { missingKeyStatus: missingIdem.status };

  const internalInvoice = await createInvoice(authorization, `smoke-invoice-internal-${nonce}`, 1100);
  const internalPayload = {
    invoice_id: internalInvoice.invoiceId,
    amount_jpyc: 1100,
    chain_id: CHAIN_ID,
    token_contract: TOKEN_CONTRACT,
    to_address: RECIPIENT,
    confirmations: 2,
    log_index: 0,
    block_number: 123,
    block_hash: `0x${"b".repeat(64)}`,
    block_timestamp: new Date().toISOString(),
    detected_at: new Date().toISOString(),
    canonical_status: "canonical",
    tx_hash: randomTxHash("internal-signed"),
    from_address: "0xservice-customer"
  };
  const mismatchSignature = await request("/api/v1/internal/payments/events:ingest", {
    method: "POST",
    headers: createServiceHeaders(internalPayload, { mismatchSignature: true, idempotencyKey: `smoke-service-badsig-${nonce}` }),
    body: JSON.stringify(internalPayload)
  });
  assert(mismatchSignature.status === 401, "signature mismatch must be rejected", mismatchSignature);

  const oldTimestamp = await request("/api/v1/internal/payments/events:ingest", {
    method: "POST",
    headers: createServiceHeaders(internalPayload, { timestamp: Math.floor(Date.now() / 1000) - 7200, idempotencyKey: `smoke-service-oldts-${nonce}` }),
    body: JSON.stringify(internalPayload)
  });
  assert(oldTimestamp.status === 401, "old timestamp must be rejected", oldTimestamp);

  const futureTimestamp = await request("/api/v1/internal/payments/events:ingest", {
    method: "POST",
    headers: createServiceHeaders(internalPayload, { timestamp: Math.floor(Date.now() / 1000) + 7200, idempotencyKey: `smoke-service-futurets-${nonce}` }),
    body: JSON.stringify(internalPayload)
  });
  assert(futureTimestamp.status === 401, "future timestamp must be rejected", futureTimestamp);

  const replayPayload = { ...internalPayload, tx_hash: randomTxHash("internal-replay") };
  const replayHeaders = createServiceHeaders(replayPayload, { idempotencyKey: `smoke-service-replay-${nonce}` });
  const replayFirst = await request("/api/v1/internal/payments/events:ingest", {
    method: "POST",
    headers: replayHeaders,
    body: JSON.stringify(replayPayload)
  });
  assert(replayFirst.status === 200 || replayFirst.status === 409, "signed internal ingest failed unexpectedly", replayFirst);
  const replaySecond = await request("/api/v1/internal/payments/events:ingest", {
    method: "POST",
    headers: replayHeaders,
    body: JSON.stringify(replayPayload)
  });
  assert(replaySecond.status === 409, "service replay guard did not reject replay", replaySecond);
  summary.internalIngestAuth = {
    missingSignatureStatus: internalIngestWithoutSignature.status,
    badSignatureStatus: mismatchSignature.status,
    oldTimestampStatus: oldTimestamp.status,
    futureTimestampStatus: futureTimestamp.status,
    replayStatus: replaySecond.status
  };

  const exactInvoice = await createInvoice(authorization, `smoke-invoice-exact-${nonce}`, 1200);
  const exactPay = await ingestPayment(authorization, `smoke-pay-exact-${nonce}`, exactInvoice, 1200, "exact");
  assert(exactPay.status === 200, "exact payment failed", exactPay);
  const exactStatus = await getInvoiceStatus(authorization, exactInvoice.invoiceId);
  assert(exactStatus.status === 200, "exact invoice status fetch failed", exactStatus);
  assert(exactStatus.data.status === "paid", "exact payment did not reach paid", exactStatus);
  summary.exact = {
    paymentDecision: exactPay.data.decision,
    invoiceStatus: exactStatus.data.status
  };

  const wrongChainInvoice = await createInvoice(authorization, `smoke-invoice-wrong-chain-${nonce}`, 1210);
  const wrongChainPay = await ingestPayment(authorization, `smoke-pay-wrong-chain-${nonce}`, wrongChainInvoice, 1210, "wrong_chain");
  assert(wrongChainPay.status === 200, "wrong chain ingest failed", wrongChainPay);
  const wrongChainStatus = await getInvoiceStatus(authorization, wrongChainInvoice.invoiceId);
  assert(wrongChainStatus.data.status === "review_required", "wrong chain did not become review_required", wrongChainStatus);

  const wrongTokenInvoice = await createInvoice(authorization, `smoke-invoice-wrong-token-${nonce}`, 1220);
  const wrongTokenPay = await ingestPayment(authorization, `smoke-pay-wrong-token-${nonce}`, wrongTokenInvoice, 1220, "wrong_token");
  assert(wrongTokenPay.status === 200, "wrong token ingest failed", wrongTokenPay);
  const wrongTokenStatus = await getInvoiceStatus(authorization, wrongTokenInvoice.invoiceId);
  assert(wrongTokenStatus.data.status === "review_required", "wrong token did not become review_required", wrongTokenStatus);
  summary.mismatchCases = {
    wrongChainDecision: wrongChainPay.data.decision,
    wrongChainStatus: wrongChainStatus.data.status,
    wrongTokenDecision: wrongTokenPay.data.decision,
    wrongTokenStatus: wrongTokenStatus.data.status
  };

  const shortageInvoice = await createInvoice(authorization, `smoke-invoice-shortage-${nonce}`, 2000);
  const shortagePay = await ingestPayment(authorization, `smoke-pay-shortage-${nonce}`, shortageInvoice, 1500, "exact");
  assert(shortagePay.status === 200, "shortage payment failed", shortagePay);
  const shortageStatus = await getInvoiceStatus(authorization, shortageInvoice.invoiceId);
  assert(shortageStatus.status === 200, "shortage invoice status fetch failed", shortageStatus);
  assert(shortageStatus.data.status === "review_required", "shortage did not become review_required", shortageStatus);
  assert(shortageStatus.data.review_case_id, "review case id missing after shortage", shortageStatus);
  summary.shortage = {
    paymentDecision: shortagePay.data.decision,
    invoiceStatus: shortageStatus.data.status,
    reviewCaseId: shortageStatus.data.review_case_id
  };

  const shortageReviewId = shortageStatus.data.review_case_id;
  const reviewUpdate = await request(`/api/v1/reviews/${shortageReviewId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-review-update-${nonce}`
    },
    body: JSON.stringify({
      status: "in_progress",
      resolution_note: "smoke test review progression"
    })
  });
  assert(reviewUpdate.status === 200, "review update failed", reviewUpdate);
  summary.review = {
    status: reviewUpdate.data.review?.status,
    reviewId: shortageReviewId
  };

  const refundInvoice = await createInvoice(authorization, `smoke-invoice-refund-${nonce}`, 2100);
  const refundOverpay = await ingestPayment(authorization, `smoke-pay-refund-overpay-${nonce}`, refundInvoice, 2100, "overpay");
  assert(refundOverpay.status === 200, "refund overpay payment failed", refundOverpay);
  const refundInvoiceStatus = await getInvoiceStatus(authorization, refundInvoice.invoiceId);
  assert(refundInvoiceStatus.status === 200, "refund overpay invoice status fetch failed", refundInvoiceStatus);
  assert(refundInvoiceStatus.data.status === "review_required", "refund overpay did not become review_required", refundInvoiceStatus);
  assert(refundInvoiceStatus.data.review_case_id, "refund overpay review case missing", refundInvoiceStatus);
  const reviewId = refundInvoiceStatus.data.review_case_id;

  const refundRequest = await request("/api/v1/refunds", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-refund-request-${nonce}`
    },
    body: JSON.stringify({
      review_case_id: reviewId,
      refund_amount_jpyc: 100,
      refund_to_address: CUSTOMER_ADDRESS,
      refund_chain_id: CHAIN_ID
    })
  });
  assert(refundRequest.status === 201, "refund request failed", refundRequest);
  const refundId = refundRequest.data.refund_request_id;

  const approveByRequester = await request(`/api/v1/refunds/${refundId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-refund-approve-requester-${nonce}`
    },
    body: "{}"
  });
  assert(approveByRequester.status === 409, "same actor approve should be blocked", approveByRequester);

  const approveRefund = await request(`/api/v1/refunds/${refundId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: approverAuthorization,
      "idempotency-key": `smoke-refund-approve-${nonce}`
    },
    body: "{}"
  });
  assert(approveRefund.status === 200, "refund approval by second actor failed", approveRefund);

  const executeByApprover = await request(`/api/v1/refunds/${refundId}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: approverAuthorization,
      "idempotency-key": `smoke-refund-execute-approver-${nonce}`
    },
    body: JSON.stringify({
      executor_type: "manual",
      refund_tx_hash: randomTxHash(`refund-approver-${refundId}`)
    })
  });
  assert(executeByApprover.status === 409, "approver should not execute when two-person execution split is active", executeByApprover);

  const executeRefund = await request(`/api/v1/refunds/${refundId}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-refund-execute-${nonce}`
    },
    body: JSON.stringify({ executor_type: "manual", refund_tx_hash: randomTxHash(`refund-${refundId}`) })
  });
  assert(executeRefund.status === 200, "refund execution failed", executeRefund);
  summary.refund = {
    requestStatus: refundRequest.status,
    approveByRequesterStatus: approveByRequester.status,
    approveStatus: approveRefund.status,
    executeByApproverStatus: executeByApprover.status,
    executeStatus: executeRefund.status,
    executeState: executeRefund.data.status,
    refundTxHash: executeRefund.data.refund_tx_hash
  };

  const invalidSignatureFetch = await request(
    `/api/v1/public/invoices/${exactInvoice.invoiceId}?sig=deadbeef&exp=${encodeURIComponent(exactInvoice.exp)}&nonce=${encodeURIComponent(exactInvoice.nonce)}`
  );
  assert(invalidSignatureFetch.status === 401, "invalid signature was not rejected", invalidSignatureFetch);
  const publicPayDisabled = await request(
    `/api/v1/public/invoices/${exactInvoice.invoiceId}/pay?sig=${encodeURIComponent(exactInvoice.sig)}&exp=${encodeURIComponent(exactInvoice.exp)}&nonce=${encodeURIComponent(exactInvoice.nonce)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amount_jpyc: 1200,
        chain_id: CHAIN_ID,
        token_contract: TOKEN_CONTRACT,
        to_address: RECIPIENT,
        confirmations: 2,
        tx_hash: randomTxHash("public-disabled"),
        from_address: CUSTOMER_ADDRESS
      })
    }
  );
  assert(publicPayDisabled.status === 403, "public pay endpoint should be disabled by default", publicPayDisabled);
  summary.publicPay = { disabledStatus: publicPayDisabled.status };

  const cancelledInvoice = await createInvoice(authorization, `smoke-invoice-cancel-${nonce}`, 1300);
  const cancelResult = await request(`/api/v1/invoices/${cancelledInvoice.invoiceId}/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-cancel-${nonce}`
    },
    body: "{}"
  });
  assert(cancelResult.status === 200, "cancel invoice failed", cancelResult);
  const cancelPay = await ingestPayment(authorization, `smoke-pay-cancelled-${nonce}`, cancelledInvoice, 1300, "exact");
  assert([200, 409].includes(cancelPay.status), "cancelled invoice payment response was unexpected", cancelPay);
  if (cancelPay.status === 200) {
    assert(cancelPay.data.status === "review_required", "cancelled invoice payment was not retained for review", cancelPay);
  }
  summary.cancelledCase = { cancelStatus: cancelResult.status, payStatus: cancelPay.status };

  const lateInvoice = await createInvoice(authorization, `smoke-invoice-late-${nonce}`, 1400);
  const markExpired = await request(`/api/v1/invoices/${lateInvoice.invoiceId}/expire`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-expire-${nonce}`
    },
    body: "{}"
  });
  assert(markExpired.status === 200, "mark expired failed", markExpired);
  const latePay = await ingestPayment(authorization, `smoke-pay-late-${nonce}`, lateInvoice, 1400, "exact");
  assert(latePay.status === 200, "late payment submission failed", latePay);
  const lateStatus = await getInvoiceStatus(authorization, lateInvoice.invoiceId);
  assert(lateStatus.data.status === "review_required", "late payment did not become review_required", lateStatus);
  summary.lateArrival = { expireStatus: markExpired.status, paymentDecision: latePay.data.decision, invoiceStatus: lateStatus.data.status };

  const overpayInvoice = await createInvoice(authorization, `smoke-invoice-overpay-${nonce}`, 1500);
  const overpay = await ingestPayment(authorization, `smoke-pay-overpay-${nonce}`, overpayInvoice, 1500, "overpay");
  assert(overpay.status === 200, "overpay submission failed", overpay);
  const overpayStatus = await getInvoiceStatus(authorization, overpayInvoice.invoiceId);
  assert(overpayStatus.data.status === "review_required", "overpay did not become review_required", overpayStatus);
  summary.overpay = { decision: overpay.data.decision, invoiceStatus: overpayStatus.data.status };

  const settlementPreview = await request("/api/v1/settlements/daily:preview", {
    headers: { authorization },
  });
  assert(settlementPreview.status === 200, "settlement preview failed", settlementPreview);
  const storeTimezone = String(settlementPreview.data?.timezone || "").trim();
  assert(storeTimezone, "settlement preview did not expose the store timezone", settlementPreview);
  const businessDate = businessDateForStoreTimezone(new Date(), storeTimezone);
  assert(
    businessDate === String(settlementPreview.data?.business_date || ""),
    "smoke business date does not match the store timezone",
    { businessDate, previewBusinessDate: settlementPreview.data?.business_date, storeTimezone },
  );
  const settlement = await request("/api/v1/settlements/daily:close", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-settlement-${nonce}`
    },
    body: JSON.stringify({ business_date: businessDate, admin_approval: true })
  });
  if (settlement.status === 409 && settlement.data?.error?.code === "UNRESOLVED_REFUNDS") {
    summary.settlement = {
      blockedByRefundEvidence: true,
      first: settlement.data,
    };
  } else if (settlement.status === 409 && settlement.data?.error?.code === "SETTLEMENT_HARD_GATE_BLOCKED") {
    const blockers = Array.isArray(settlement.data?.error?.details?.blockers)
      ? settlement.data.error.details.blockers
      : [];
    assert(
      blockers.some((blocker) => blocker?.code === "OPEN_REVIEW_INCIDENTS"),
      "settlement hard gate did not expose the open review incident blocker",
      settlement,
    );
    summary.settlement = {
      blockedByHardGate: true,
      blockerCodes: blockers.map((blocker) => blocker.code),
      first: settlement.data,
    };
  } else {
    assert(settlement.status === 200, "settlement close failed", settlement);
    const settlementAgain = await request("/api/v1/settlements/daily:close", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
        "idempotency-key": `smoke-settlement-repeat-${nonce}`
      },
      body: JSON.stringify({ business_date: businessDate })
    });
    assert(settlementAgain.status === 200, "repeat settlement failed", settlementAgain);
    assert(settlementAgain.data.already_closed === true, "repeat settlement should be already_closed", settlementAgain);
    summary.settlement = {
      first: settlement.data,
      second: settlementAgain.data
    };
  }

  const audit = await request("/api/v1/audit-logs?limit=10&offset=0", {
    headers: { authorization }
  });
  assert(audit.status === 200, "audit log fetch failed", audit);
  assert(Array.isArray(audit.data.audit_logs), "audit logs payload invalid", audit);
  summary.audit = {
    returned: audit.data.page?.returned,
    page: audit.data.page
  };

  const sessionList = await request(`/api/v1/terminal-sessions?terminal_id=${encodeURIComponent(initialLogin.login.data.terminalId)}&include_ended=true`, {
    headers: { authorization }
  });
  assert(sessionList.status === 200, "terminal session list failed", sessionList);
  assert(Array.isArray(sessionList.data.sessions), "terminal session list payload invalid", sessionList);
  const approverSessionId = approverLogin.login.data.sessionId;
  const approverSession = sessionList.data.sessions.find((session) => session.id === approverSessionId);
  assert(approverSession?.staff_user_id === "staff-002", "smoke approver is not the seeded staff-002 fixture", sessionList);
  const forceRevoke = await request(`/api/v1/terminal-sessions/${approverSessionId}/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": `smoke-session-revoke-${nonce}`
    },
    body: "{}"
  });
  assert(forceRevoke.status === 200, "session force revoke failed", forceRevoke);
  const approverAfterRevoke = await request(`/api/v1/invoices/${exactInvoice.invoiceId}`, {
    headers: { authorization: approverAuthorization }
  });
  assert(approverAfterRevoke.status === 401, "revoked session should be unauthorized", approverAfterRevoke);
  summary.sessionAdmin = {
    listed: sessionList.data.sessions.length,
    approverStaffUserId: approverSession.staff_user_id,
    forceRevokeStatus: forceRevoke.status,
    approverAfterRevokeStatus: approverAfterRevoke.status
  };

  if (SESSION_EXPIRE_WAIT_MS > 0) {
    const ttlLogin = await loginAs(STAFF_PIN);
    await new Promise((resolve) => setTimeout(resolve, SESSION_EXPIRE_WAIT_MS));
    const expiredStatus = await request(`/api/v1/invoices/${exactInvoice.invoiceId}`, {
      headers: { authorization: ttlLogin.authorization }
    });
    assert(expiredStatus.status === 401, "session expiration test failed", expiredStatus);
    summary.sessionExpiry = { waitMs: SESSION_EXPIRE_WAIT_MS, status: expiredStatus.status };
  }

  const logoutLogin = await loginAs(STAFF_PIN);
  let logoutAuthorization = logoutLogin.authorization;
  let logout = await request("/api/v1/terminal-sessions/current", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      authorization: logoutAuthorization,
      "idempotency-key": `smoke-logout-${nonce}`
    },
    body: "{}"
  });
  if (logout.status === 401 && SESSION_EXPIRE_WAIT_MS > 0) {
    const retryLogin = await loginAs(STAFF_PIN);
    logoutAuthorization = retryLogin.authorization;
    logout = await request("/api/v1/terminal-sessions/current", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        authorization: logoutAuthorization,
        "idempotency-key": `smoke-logout-retry-${nonce}`
      },
      body: "{}"
    });
  }
  assert(logout.status === 200, "logout failed", logout);
  const afterLogout = await request(`/api/v1/invoices/${exactInvoice.invoiceId}`, {
    headers: { authorization: logoutAuthorization }
  });
  assert(afterLogout.status === 401, "logged out session still authorized", afterLogout);
  summary.session = { logoutStatus: logout.status, afterLogoutStatus: afterLogout.status };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await stopServer(autoServer);
  }
}

main().catch((error) => {
  console.error("SMOKE_TEST_FAILED");
  console.error(error.message);
  if (error.payload) {
    console.error(JSON.stringify(error.payload, null, 2));
  }
  process.exit(1);
});
