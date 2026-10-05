import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { productionServerEnv, startServerProcess, stopServerProcess } from "./helpers/server-process.mjs";

const ROOT = process.cwd();
const validatorEnv = {
  APP_ENV: "production", DEPLOYMENT_TOPOLOGY: "local_store_terminal",
  APP_BIND_HOST: "127.0.0.1", APP_HOST: "http://127.0.0.1:4173", PAY_BASE_URL: "http://127.0.0.1:4173",
  INTERNAL_APP_ORIGIN: "http://127.0.0.1:4173", CORS_ALLOW_ORIGINS: "http://127.0.0.1:4173",
  PUBLIC_POLICY_ORIGIN: "https://policies.merchant.jp", PUBLIC_BASE_URL: "https://policies.merchant.jp",
  PUBLIC_PAYMENT_PAGE_ENABLED: "false", TRUST_PROXY: "false",
  DB_PATH: "./synthetic-financial.db", WORKER_STATE_DB_PATH: "./synthetic-worker.db", BACKUP_DIR: "./synthetic-backups",
  CHAIN_ID: "137", ENABLED_PAYMENT_CHAIN_IDS: "137", RPC_URLS_137: "https://rpc.merchant.jp",
  TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
  APPROVED_JPYC_TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29", TOKEN_DECIMALS: "18",
  RECIPIENT_ADDRESS: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", WALLET_ADAPTER_TYPE: "wallet_deeplink",
  LOCAL_TERMINAL_OPERATOR_READINESS_REF: "SYNTHETIC-MAC-READY",
};

function validate(overrides) {
  return new Promise((resolve) => execFile(process.execPath,
    ["scripts/production-validation/validate-production-config.mjs", "--skip-rpc", "--allow-empty"],
    { cwd: ROOT, env: { PATH: process.env.PATH, ...validatorEnv, ...overrides } },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, payload: JSON.parse(stdout), stderr })));
}

function runtimeEnv(overrides = {}) {
  const env = productionServerEnv({ APP_ENV: "development", DEPLOYMENT_STAGE: "pilot", COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_TOPOLOGY: "local_store_terminal", TRUST_PROXY: "false", TRUST_PROXY_HOPS: "",
    PUBLIC_POLICY_ORIGIN: validatorEnv.PUBLIC_POLICY_ORIGIN, PUBLIC_BASE_URL: validatorEnv.PUBLIC_BASE_URL,
    PUBLIC_PAYMENT_PAGE_ENABLED: "false", BACKUP_DIR: "./synthetic-backups",
    RPC_URLS_137: "https://rpc.merchant.jp", LOCAL_TERMINAL_OPERATOR_READINESS_REF: "SYNTHETIC-MAC-READY" });
  const origin = `http://127.0.0.1:${env.APP_PORT}`;
  return { ...env, APP_HOST: origin, PAY_BASE_URL: origin, INTERNAL_APP_ORIGIN: origin, CORS_ALLOW_ORIGINS: origin, ...overrides };
}

async function startupExit(env) {
  const logs = [];
  const proc = spawn(process.execPath, ["src/server.mjs"], { cwd: ROOT, env: { PATH: process.env.PATH, ...env } });
  proc.stdout.on("data", (chunk) => logs.push(String(chunk)));
  proc.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, timedOut: true }), 2000);
    proc.once("exit", (code) => { clearTimeout(timer); resolve({ code, timedOut: false }); });
  });
  await stopServerProcess(proc);
  return { ...result, logs: logs.join("") };
}

test("local validator rejects Docker and unsafe ingest origins even in template mode", async (t) => {
  for (const origin of ["http://app:4173", "", "http://192.168.1.10:4173", "https://127.0.0.1:4173",
    "http://user:pass@127.0.0.1:4173", "http://127.0.0.1:4173/path", "http://127.0.0.1:4173?q=1",
    "http://127.0.0.1:4174", "http://localhost:4173"]) {
    await t.test(origin || "missing", async () => {
      const result = await validate({ INTERNAL_APP_ORIGIN: origin });
      assert.notEqual(result.code, 0);
      assert.match(JSON.stringify(result.payload), /internal_app_origin/i);
    });
  }
});

test("local validator requires the browser origin and rejects wildcard CORS even in template mode", async (t) => {
  for (const cors of ["https://pay.miyamibu.xyz", "", "*", "http://127.0.0.1:*", "http://127.0.0.1:4173,*", "http://127.0.0.1:4173/"]) {
    await t.test(cors || "missing", async () => {
      const result = await validate({ CORS_ALLOW_ORIGINS: cors });
      assert.notEqual(result.code, 0);
      assert.match(JSON.stringify(result.payload), /CORS_ALLOW_ORIGINS/);
    });
  }
});

test("valid local loopback origins pass structural preflight including IPv6", async (t) => {
  for (const origin of ["http://127.0.0.1:4173", "http://localhost:4173", "http://[::1]:4173"]) {
    await t.test(origin, async () => {
      const APP_BIND_HOST = new URL(origin).hostname.replace(/^\[|\]$/g, "");
      const result = await validate({ APP_BIND_HOST, APP_HOST: origin, PAY_BASE_URL: origin, INTERNAL_APP_ORIGIN: `${origin}/`, CORS_ALLOW_ORIGINS: origin });
      assert.equal(result.code, 0, JSON.stringify(result.payload));
      assert.ok(result.payload.checks.some((check) => check.name === "cors_origins_include_app_host" && check.ok));
    });
  }
});

test("local production-like runtime accepts signed worker reads and browser login without weakening service auth", async (parent) => {
  for (const APP_ENV of ["development", "production"]) await parent.test(APP_ENV, async (t) => {
    const env = runtimeEnv({ APP_ENV });
    const started = await startServerProcess(ROOT, env);
    t.after(() => stopServerProcess(started.proc));
    const login = await fetch(`${env.APP_HOST}/api/v1/terminal-sessions`, {
      method: "POST", headers: { "content-type": "application/json", Origin: env.APP_HOST },
      body: JSON.stringify({ terminalCode: env.BOOTSTRAP_TERMINAL_CODE, staffPin: env.BOOTSTRAP_ADMIN_PIN }),
    });
    assert.equal(login.status, 201, await login.text());
    assert.equal(login.headers.get("access-control-allow-origin"), env.APP_HOST);
    const apiPath = "/api/v1/internal/chain/candidates:read";
    const unsigned = await fetch(`${env.INTERNAL_APP_ORIGIN}${apiPath}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.ok([401, 403].includes(unsigned.status), `unsigned status ${unsigned.status}`);
    // Execute the unchanged worker's actual signing/transport function with a
    // synthetic secret and a real loopback fetch; no worker RPC or wallet runs.
    const worker = fs.readFileSync("src/chain-monitor.mjs", "utf8");
    const source = worker.match(/async function postSignedServiceJson\(apiPath, payload, idempotencyKey\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(source);
    const post = vm.runInNewContext(`${source}; postSignedServiceJson`, {
      crypto, fetch, Date, JSON, INTERNAL_APP_ORIGIN: env.INTERNAL_APP_ORIGIN, APP_HOST: env.APP_HOST,
      SERVICE_INGEST_SECRET: env.SERVICE_INGEST_SECRET, SERVICE_INGEST_ID: "chain-monitor",
      sha256: (value) => crypto.createHash("sha256").update(String(value)).digest("hex"),
      hmac: (secret, value) => crypto.createHmac("sha256", secret).update(value).digest("hex"),
    });
    const result = await post(apiPath, { chain_id: "137", token_contract: env.TOKEN_CONTRACT }, crypto.randomUUID());
    assert.equal(result.source, "api-server");
    assert.equal(result.page.returned, 0);
  });
});

test("local pilot rejects unreachable ingest and wrong CORS before opening its DB", async (t) => {
  for (const overrides of [{ INTERNAL_APP_ORIGIN: "http://app:4173" }, { CORS_ALLOW_ORIGINS: "https://pay.miyamibu.xyz" }]) {
    await t.test(Object.keys(overrides)[0], async () => {
      const env = runtimeEnv({ ...overrides, ...(overrides.CORS_ALLOW_ORIGINS ? { DEPLOYMENT_STAGE: "development" } : {}) });
      const result = await startupExit(env);
      assert.equal(result.timedOut, false, result.logs);
      assert.notEqual(result.code, 0);
      assert.equal(fs.existsSync(env.DB_PATH), false, "invalid topology must fail before financial DB initialization");
    });
  }
});

test("public cloud keeps its same-origin worker rejection", async () => {
  const env = productionServerEnv({ APP_ENV: "development", DEPLOYMENT_STAGE: "pilot", COMMERCIAL_GO_MODE: "false" });
  env.INTERNAL_APP_ORIGIN = env.APP_HOST;
  const result = await startupExit(env);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.logs, /INTERNAL_APP_ORIGIN must not equal the public APP_HOST/);
});
