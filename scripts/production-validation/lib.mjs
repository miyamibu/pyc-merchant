import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function randomPort() {
  return 47000 + Math.floor(Math.random() * 10000);
}

const VALIDATION_WALLET_TEMPLATE = "hashport://pay?uri={{payment_uri_encoded}}";
const VALIDATION_WALLET_REGISTRY = JSON.stringify([{
  adapter_id: "hashport-jpyc-validation-v1",
  wallet_name: "HashPort Wallet",
  allowed_scheme: "hashport",
  allowed_https_hosts: [],
  template: VALIDATION_WALLET_TEMPLATE,
  template_sha256: "1ecf7086f29836a142a2bcbea5a7dde2109c4d31d5b381122794649b237be5db",
  approved_at: "2026-07-25T00:00:00.000Z",
  approval_ref: "WALLET-VALIDATION-001",
  tested_ios_versions: ["18.5"],
  tested_android_versions: [],
  tested_wallet_versions: ["1.0.0"],
  revoked_at: null,
}]);

export function createValidationEnv(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "jpyc-production-validation-"));
  const port = overrides.APP_PORT ? Number(overrides.APP_PORT) : randomPort();
  return {
    APP_ENV: "development",
    APP_PORT: String(port),
    APP_HOST: `http://127.0.0.1:${port}`,
    DB_PATH: path.join(root, "app.db"),
    WORKER_STATE_DB_PATH: path.join(root, "worker-state.db"),
    APP_SECRET: "a".repeat(48),
    SERVICE_INGEST_SECRET: "b".repeat(48),
    METRICS_SECRET: "c".repeat(48),
    CHAIN_ID: "137",
    ENABLED_PAYMENT_CHAIN_IDS: "1,43114,137",
    TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
    APPROVED_JPYC_TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
    JPYC_CONTRACT_APPROVAL_REF: "CAB-VALIDATION-001",
    RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
    // This is a development-only validation fixture. Production keeps the
    // receive-address pool fail-closed until an approved manifest is imported.
    RECEIVE_ADDRESS_DEV_AUTO_VERIFY: "true",
    TOKEN_SYMBOL: "JPYC",
    TOKEN_DECIMALS: "18",
    LEDGER_DECIMALS: "6",
    LEDGER_BASE_UNIT_SCALE: "1000000",
    REQUIRED_CONFIRMATIONS: "2",
    MIN_REQUIRED_CONFIRMATIONS: "2",
    MONITOR_BACKSCAN_BLOCKS: "12",
    MIN_MONITOR_BACKSCAN_BLOCKS: "12",
    CONFIRMATIONS_POLICY_APPROVAL_REF: "CONF-VALIDATION-001",
    BACKSCAN_POLICY_APPROVAL_REF: "BACKSCAN-VALIDATION-001",
    CHECKOUT_SESSION_IMPLEMENTED: "true",
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_HELP_URL: "https://support.walletconnect.com/",
    HASHPORT_WALLET_DEEPLINK_TEMPLATE: "hashport://pay?uri={{payment_uri_encoded}}",
    WALLET_ADAPTER_REGISTRY_JSON: VALIDATION_WALLET_REGISTRY,
    SUPPORTED_WALLETS: "HashPort Wallet,WalletConnect,Injected Wallet",
    STAFF_PIN: "2468",
    SECOND_ADMIN_PIN: "8642",
    TERMINAL_CODE: "TERM-VAL-01",
    ALLOW_MANUAL_PAYMENT_INGEST: "false",
    SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS: "false",
    LEGAL_GATE_APPROVED: "true",
    LEGAL_GATE_APPROVAL_REF: "LEGAL-VALIDATION-001",
    AML_POLICY_APPROVED: "true",
    AML_POLICY_APPROVAL_REF: "AML-VALIDATION-001",
    PRIVACY_POLICY_APPROVED: "true",
    PRIVACY_POLICY_APPROVAL_REF: "PRIVACY-VALIDATION-001",
    APPI_POLICY_APPROVED: "true",
    APPI_POLICY_APPROVAL_REF: "APPI-VALIDATION-001",
    APPI_RETENTION_POLICY_REF: "APPI-RET-VALIDATION-001",
    APPI_DELETION_PROCEDURE_REF: "APPI-DEL-VALIDATION-001",
    APPI_DISCLOSURE_PROCEDURE_REF: "APPI-DIS-VALIDATION-001",
    ...overrides,
  };
}

export async function startValidationServer(cwd, envMap) {
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd,
    env: { ...process.env, ...envMap },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  proc.stdout.on("data", (chunk) => logs.push(String(chunk)));
  proc.stderr.on("data", (chunk) => logs.push(String(chunk)));
  try {
    await waitForHealth(envMap.APP_HOST, proc, logs);
  } catch (error) {
    await stopValidationServer(proc);
    throw error;
  }
  return { proc, baseUrl: envMap.APP_HOST, logs, env: envMap };
}

export async function stopValidationServer(proc) {
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

async function waitForHealth(baseUrl, proc, logs, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode != null) {
      throw new Error(`validation server exited early\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (_error) {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`validation server not ready within ${timeoutMs}ms\n${logs.join("")}`);
}

export async function apiRequest(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, options);
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { status: response.status, data, headers: response.headers };
}

export async function loginAs(baseUrl, { terminalCode, pin, staffName }) {
  const login = await apiRequest(baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalCode, staffPin: pin, staffName }),
  });
  if (login.status !== 201) {
    throw new Error(`validation login failed: ${JSON.stringify(login.data)}`);
  }
  return login.data.token;
}

export async function createInvoice(baseUrl, token, amountJpy, idempotencyKey, paymentChainId = "137") {
  const response = await apiRequest(baseUrl, "/api/v1/invoices", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ amount_jpy: amountJpy, payment_chain_id: String(paymentChainId) }),
  });
  if (response.status !== 201) {
    throw new Error(`validation invoice creation failed: ${JSON.stringify(response.data)}`);
  }
  return response.data;
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
