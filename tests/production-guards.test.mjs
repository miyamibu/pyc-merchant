import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { apiRequest, authHeaders, loginAs, productionServerEnv } from "./helpers/server-process.mjs";

const CWD = process.cwd();

function spawnServer(envMap) {
  const logs = [];
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: CWD,
    env: { ...process.env, ...envMap },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => logs.push(String(chunk)));
  proc.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return { proc, logs };
}

async function waitExit(proc, logs, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (_error) {
        // no-op
      }
      reject(new Error(`process did not exit in ${timeoutMs}ms\n${logs.join("")}`));
    }, timeoutMs);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, logs: logs.join("") });
    });
  });
}

async function waitForHealth(port, logs, proc, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode != null) {
      throw new Error(`server exited before health check\n${logs.join("")}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch (_error) {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`health check timeout\n${logs.join("")}`);
}

async function stopProc(proc) {
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

test("production fatal guards reject unsafe startup configs", async (t) => {
  const cases = [
    {
      name: "simulation enabled",
      env: { ENABLE_PUBLIC_PAYMENT_SIMULATION: "true" },
      pattern: /ENABLE_PUBLIC_PAYMENT_SIMULATION/i,
    },
    {
      name: "mock wallet adapter",
      env: { WALLET_ADAPTER_TYPE: "mock" },
      pattern: /WALLET_ADAPTER_TYPE=mock/i,
    },
    {
      name: "default credentials",
      env: { STAFF_PIN: "1234" },
      pattern: /default credentials\/codes/i,
    },
    {
      name: "wrong chain",
      env: { CHAIN_ID: "10" },
      pattern: /CHAIN_ID must be included in ENABLED_PAYMENT_CHAIN_IDS/i,
    },
    {
      name: "token mismatch",
      env: { TOKEN_CONTRACT: "0xcccccccccccccccccccccccccccccccccccccccc" },
      pattern: /official funds-transfer JPYC contract/i,
    },
    {
      name: "confirmation below minimum",
      env: { REQUIRED_CONFIRMATIONS: "1", MIN_REQUIRED_CONFIRMATIONS: "2" },
      pattern: /below policy minimum/i,
    },
    {
      name: "missing metrics secret",
      env: { METRICS_SECRET: "__REPLACE_WITH_METRICS_SECRET__" },
      pattern: /METRICS_SECRET/i,
    },
    {
      name: "missing jpyc approval ref",
      env: { JPYC_CONTRACT_APPROVAL_REF: "" },
      pattern: /JPYC_CONTRACT_APPROVAL_REF/i,
    },
    {
      name: "weak legal approval ref",
      env: { LEGAL_GATE_APPROVAL_REF: ["place", "holder"].join("") },
      pattern: /LEGAL_GATE_APPROVAL_REF/i,
    },
    {
      name: "missing confirmations policy ref",
      env: { CONFIRMATIONS_POLICY_APPROVAL_REF: "" },
      pattern: /CONFIRMATIONS_POLICY_APPROVAL_REF/i,
    },
    {
      name: "missing backscan policy ref",
      env: { BACKSCAN_POLICY_APPROVAL_REF: "" },
      pattern: /BACKSCAN_POLICY_APPROVAL_REF/i,
    },
    {
      name: "legal gates not approved",
      env: { LEGAL_GATE_APPROVED: "false" },
      pattern: /legal\/AML\/privacy\/APPI approvals/i,
    },
    {
      name: "missing wallet deeplink template",
      env: { WALLET_DEEPLINK_TEMPLATE: "" },
      pattern: /wallet deeplink adapter is not fully configured/i,
    },
    {
      name: "missing internal worker origin",
      env: { INTERNAL_APP_ORIGIN: "" },
      pattern: /INTERNAL_APP_ORIGIN/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const env = productionServerEnv(scenario.env);
      const { proc, logs } = spawnServer(env);
      const result = await waitExit(proc, logs);
      assert.notEqual(result.code, 0, `expected non-zero exit: ${scenario.name}`);
      assert.match(result.logs, scenario.pattern);
    });
  }
});

test("production manual ingest and unsigned audit export are disabled by default", async () => {
  const env = productionServerEnv({
    ALLOW_MANUAL_PAYMENT_INGEST: "false",
  });
  const port = Number(env.APP_PORT);
  const { proc, logs } = spawnServer(env);
  try {
    await waitForHealth(port, logs, proc);

    const login = await loginAs(`http://127.0.0.1:${port}`, {
      terminalCode: env.BOOTSTRAP_TERMINAL_CODE,
      pin: env.BOOTSTRAP_ADMIN_PIN,
      staffName: "Bootstrap Admin",
    });

    const ingest = await apiRequest(`http://127.0.0.1:${port}`, "/api/v1/payments/events:ingest", {
      method: "POST",
      headers: authHeaders(login.token, {
        "content-type": "application/json",
        "idempotency-key": `prod-manual-ingest-${Date.now()}`,
      }),
      body: JSON.stringify({
        invoice_id: "dummy",
        amount_jpyc: 1,
        chain_id: "137",
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 2,
        tx_hash: "0x" + "1".repeat(64),
      }),
    });
    assert.equal(ingest.status, 403);
    assert.equal(ingest.data.error.code, "MANUAL_INGEST_DISABLED");

    const exportAudit = await apiRequest(`http://127.0.0.1:${port}`, "/api/v1/audit-logs/export?format=json&limit=10", {
      headers: authHeaders(login.token),
    });
    assert.equal(exportAudit.status, 503);
    assert.equal(exportAudit.data.error.code, "PRIVACY_POLICY_NOT_APPROVED");
    assert.equal(exportAudit.data.error.details.privacy.source, "release_bound_signed_manifest");
    assert.equal(exportAudit.data.error.details.privacy.ok, false);
    assert.equal(exportAudit.data.error.details.appi.ok, false);
  } finally {
    await stopProc(proc);
  }
});
