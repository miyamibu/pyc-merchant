import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

let portCounter = 0;

const PRODUCTION_WALLET_TEMPLATE = "wallet://pay?uri={{payment_uri_encoded}}";
const PRODUCTION_WALLET_REGISTRY = JSON.stringify([{
  adapter_id: "hashport-jpyc-test-v1",
  wallet_name: "HashPort Wallet",
  allowed_scheme: "wallet",
  allowed_https_hosts: [],
  template: PRODUCTION_WALLET_TEMPLATE,
  template_sha256: createHash("sha256").update(PRODUCTION_WALLET_TEMPLATE, "utf8").digest("hex"),
  approved_at: "2026-07-25T00:00:00.000Z",
  approval_ref: "WALLET-TEST-2026-001",
  tested_ios_versions: ["18.5"],
  tested_android_versions: [],
  tested_wallet_versions: ["1.0.0"],
  revoked_at: null,
}]);

function randomPort() {
  portCounter = (portCounter + 1) % 50_000;
  return 10_000 + ((process.pid * 997 + portCounter * 131 + randomInt(0, 50_000)) % 50_000);
}

export function baseServerEnv(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "jpyc-terminal-test-"));
  const port = overrides.APP_PORT ? Number(overrides.APP_PORT) : randomPort();
  const base = {
    APP_ENV: "development",
    APP_PORT: String(port),
    APP_HOST: `http://127.0.0.1:${port}`,
    INTERNAL_APP_ORIGIN: "http://app:4173",
    APP_BIND_HOST: "127.0.0.1",
    DB_PATH: path.join(root, "app.db"),
    WORKER_STATE_DB_PATH: path.join(root, "worker-state.db"),
    APP_SECRET: "a".repeat(48),
    PAYMENT_RECEIPT_KEY_RING: `app-secret-v1=${"a".repeat(48)}`,
    SERVICE_INGEST_SECRET: "b".repeat(48),
    METRICS_SECRET: "c".repeat(48),
    CHAIN_ID: "137",
    TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
    RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
    TOKEN_DECIMALS: "18",
    LEDGER_DECIMALS: "6",
    LEDGER_BASE_UNIT_SCALE: "1000000",
    RECEIVE_ADDRESS_DEV_AUTO_VERIFY: "true",
    REQUIRED_CONFIRMATIONS: "2",
    MIN_REQUIRED_CONFIRMATIONS: "2",
    ENABLE_PUBLIC_PAYMENT_SIMULATION: "false",
    WALLET_ADAPTER_TYPE: "mock",
    ENABLE_REOWN: "false",
    CHECKOUT_SESSION_IMPLEMENTED: "true",
    STAFF_PIN: "1234",
    SECOND_ADMIN_PIN: "5678",
    TERMINAL_CODE: "TERM-001",
    ALLOW_MANUAL_PAYMENT_INGEST: "false",
    SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS: "false",
  };
  return { ...base, ...overrides };
}

export function productionServerEnv(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "jpyc-terminal-prod-test-"));
  const port = overrides.APP_PORT ? Number(overrides.APP_PORT) : randomPort();
  const tokenContract = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
  return {
    APP_ENV: "production",
    APP_PORT: String(port),
    APP_HOST: `https://terminal.example.com:${port}`,
    INTERNAL_APP_ORIGIN: `http://127.0.0.1:${port}`,
    DB_PATH: path.join(root, "app.db"),
    WORKER_STATE_DB_PATH: path.join(root, "worker-state.db"),
    APP_SECRET: "p".repeat(48),
    PAYMENT_RECEIPT_KEY_RING: `app-secret-v1=${"p".repeat(48)}`,
    SERVICE_INGEST_SECRET: "q".repeat(48),
    METRICS_SECRET: "r".repeat(48),
    CHAIN_ID: "137",
    TOKEN_CONTRACT: tokenContract,
    APPROVED_JPYC_TOKEN_CONTRACT: tokenContract,
    // Non-secret test pins keep production startup on the intended metadata gate.
    // They are deliberately synthetic and are never used as production approval values.
    APPROVED_TOKEN_NAME: "JPYC",
    APPROVED_TOKEN_CODE_HASH: `0x${"1".repeat(64)}`,
    APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH: `0x${"2".repeat(64)}`,
    JPYC_CONTRACT_APPROVAL_REF: "CAB-2026-001",
    LEGAL_GATE_APPROVAL_REF: "LEGAL-2026-001",
    AML_POLICY_APPROVAL_REF: "AML-2026-001",
    PRIVACY_POLICY_APPROVAL_REF: "PRIV-2026-001",
    APPI_POLICY_APPROVED: "true",
    APPI_POLICY_APPROVAL_REF: "APPI-2026-001",
    APPI_RETENTION_POLICY_REF: "APPI-RET-2026-001",
    APPI_DELETION_PROCEDURE_REF: "APPI-DEL-2026-001",
    APPI_DISCLOSURE_PROCEDURE_REF: "APPI-DIS-2026-001",
    CONFIRMATIONS_POLICY_APPROVAL_REF: "CONF-2026-001",
    BACKSCAN_POLICY_APPROVAL_REF: "BACKSCAN-2026-001",
    REFUND_TREASURY_ADDRESS: "0xdddddddddddddddddddddddddddddddddddddddd",
    REFUND_TREASURY_APPROVAL_REF: "TREASURY-2026-001",
    RECIPIENT_ADDRESS: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    TOKEN_DECIMALS: "18",
    LEDGER_DECIMALS: "6",
    LEDGER_BASE_UNIT_SCALE: "1000000",
    REQUIRED_CONFIRMATIONS: "2",
    MIN_REQUIRED_CONFIRMATIONS: "2",
    MONITOR_BACKSCAN_BLOCKS: "12",
    MIN_MONITOR_BACKSCAN_BLOCKS: "12",
    ENABLE_PUBLIC_PAYMENT_SIMULATION: "false",
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: PRODUCTION_WALLET_TEMPLATE,
    WALLET_ADAPTER_REGISTRY_JSON: PRODUCTION_WALLET_REGISTRY,
    CHECKOUT_SESSION_IMPLEMENTED: "true",
    STAFF_PIN: "2468",
    TERMINAL_CODE: "TERM-900",
    BOOTSTRAP_ADMIN_PIN: "8642",
    BOOTSTRAP_TERMINAL_CODE: "TERM-901",
    TRUST_PROXY_HOPS: "1",
    TRUST_PROXY_CIDRS: "",
    ALLOW_MANUAL_PAYMENT_INGEST: "false",
    LEGAL_GATE_APPROVED: "true",
    AML_POLICY_APPROVED: "true",
    PRIVACY_POLICY_APPROVED: "true",
    ...overrides,
  };
}

export async function startServerProcess(cwd, envMap) {
  const proc = spawn("node", ["src/server.mjs"], {
    cwd,
    env: { ...process.env, ...envMap },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  proc.stdout.on("data", (chunk) => logs.push(String(chunk)));
  proc.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const baseUrl = envMap.APP_HOST;
  await waitForServer(baseUrl, proc, logs, 15_000);

  return { proc, baseUrl, logs, env: envMap };
}

export async function stopServerProcess(proc) {
  if (!proc || proc.exitCode != null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (_error) {
        // no-op
      }
      resolve();
    }, 3000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

export async function waitForServer(baseUrl, proc, logsRef, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode != null) {
      throw new Error(`server exited early code=${proc.exitCode}\n${(logsRef || []).join("")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch (_error) {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`server did not become ready in ${timeoutMs}ms\n${(logsRef || []).join("")}`);
}

export async function apiRequest(baseUrl, pathName, options = {}) {
  const res = await fetch(`${baseUrl}${pathName}`, options);
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { status: res.status, data, headers: res.headers };
}

export async function loginAs(baseUrl, { terminalCode, pin, staffName }) {
  const res = await apiRequest(baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalCode,
      staffPin: pin,
      staffName: staffName || undefined,
    }),
  });
  if (res.status !== 201) {
    throw new Error(`login failed: ${JSON.stringify(res.data)}`);
  }
  return {
    token: res.data.token,
    role: res.data.role,
    terminalId: res.data.terminalId,
    storeId: res.data.storeId,
    sessionId: res.data.sessionId,
    fixedQrUrl: res.data.fixed_qr_url,
    publicEntryToken: res.data.public_entry_token,
  };
}

export function authHeaders(token, extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

export async function createInvoice(baseUrl, token, amount, idem = `inv-${Date.now()}`) {
  return apiRequest(baseUrl, "/api/v1/invoices", {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": idem,
    }),
    body: JSON.stringify({ amount_jpy: amount, payment_chain_id: "137" }),
  });
}

export async function getInvoice(baseUrl, token, invoiceId) {
  return apiRequest(baseUrl, `/api/v1/invoices/${encodeURIComponent(invoiceId)}`, {
    headers: authHeaders(token),
  });
}

export async function ingestManualPayment(baseUrl, token, payload, idem = `pay-${Date.now()}`) {
  const eventPayload = {
    canonical_status: "canonical",
    log_index: 0,
    block_number: 123,
    block_timestamp: new Date().toISOString(),
    ...payload,
  };
  return apiRequest(baseUrl, "/api/v1/payments/events:ingest", {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": idem,
    }),
    body: JSON.stringify(eventPayload),
  });
}

export function randomTxHash(seed = "") {
  const raw = `${seed}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const hex = Buffer.from(raw).toString("hex").slice(0, 64).padEnd(64, "0");
  return `0x${hex}`;
}

export function parsePaymentUrl(paymentUrl) {
  const url = new URL(String(paymentUrl));
  const ref = url.searchParams.get("ref");
  if (!ref) {
    return {
      invoiceId: url.searchParams.get("invoiceId"),
      sig: url.searchParams.get("sig"),
      exp: url.searchParams.get("exp"),
      nonce: url.searchParams.get("nonce"),
    };
  }
  const decoded = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
  return {
    invoiceId: decoded.invoice_id || null,
    sig: decoded.sig || null,
    exp: String(decoded.exp || ""),
    nonce: decoded.nonce || null,
  };
}
