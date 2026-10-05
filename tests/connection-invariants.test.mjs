import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import http from "node:http";
import Database from "better-sqlite3";
import { spawn, execFile } from "node:child_process";
import * as topology from "../src/deployment-topology.mjs";
import { productionServerEnv, stopServerProcess, waitForServer } from "./helpers/server-process.mjs";

const baseline = process.env.JPYC_EXPECT_BASELINE === "true";
const original = fs.readFileSync("tests/listener-preflight-regression.test.mjs", "utf8");
const fixtureContext = {};
vm.runInNewContext(original.slice(original.indexOf("const fixture ="), original.indexOf("function origins"))
  .replace("const fixture =", "fixture ="), fixtureContext);
const fixture = fixtureContext.fixture;
const serverSource = fs.readFileSync("src/server.mjs", "utf8");
function loadedEnv(processEnv, file = null) {
  const defaultsSource = serverSource.match(/const DEFAULTS = \{[\s\S]*?\n\};/)[0];
  const loader = serverSource.match(/function loadEnv\(\) \{[\s\S]*?\n\}/)[0];
  return vm.runInNewContext(`${defaultsSource};${loader};loadEnv()`, {
    fs: { existsSync: () => file !== null, readFileSync: () => file }, path, CWD: "/synthetic", process: { env: processEnv },
    CONNECTION_ENV_KEYS: topology.CONNECTION_ENV_KEYS,
  });
}
function validator(overrides) {
  return new Promise(resolve => execFile(process.execPath,
    ["scripts/production-validation/validate-production-config.mjs", "--skip-rpc", "--allow-empty"],
    { cwd: process.cwd(), env: { PATH: process.env.PATH, ...fixture, ...overrides } },
    (error, stdout) => resolve({ code: error?.code ?? 0, result: JSON.parse(stdout) })));
}
function originPort(port) {
  const origin = new URL(`http://127.0.0.1:${port}`).origin;
  return { APP_HOST: origin, PAY_BASE_URL: origin, INTERNAL_APP_ORIGIN: origin, CORS_ALLOW_ORIGINS: origin };
}

test("actual env loader and listener use the same APP_PORT / PORT precedence", async t => {
  for (const [label, values, expected] of [
    ["default", {}, 4173], ["explicit", { APP_PORT: "5001", PORT: "5002" }, 5001],
    ["alias only", { PORT: "5002" }, 5002], ["empty explicit", { APP_PORT: "", PORT: "5002" }, 5002],
    ["env file empty explicit", { PORT: "5002" }, 5002],
  ]) await t.test(label, async () => {
    const env = loadedEnv(values, label === "env file empty explicit" ? "APP_PORT=\n" : null);
    const actual = vm.runInNewContext(serverSource.match(/const PORT = .*;/)[0] + ";PORT", {
      ENV: env, DEFAULTS: { APP_PORT: "4173" }, resolveListenerPort: topology.resolveListenerPort,
    });
    const wasMasked = baseline && ["alias only", "empty explicit"].includes(label);
    assert.equal(actual, wasMasked ? 4173 : expected);
    const normal = { ...fixture, ...originPort(expected), ...values, APP_PORT: values.APP_PORT || "" };
    if (!baseline) {
      assert.equal(topology.evaluateLocalStoreTerminalTopology(normal).ok, true);
      assert.equal((await validator({ ...originPort(expected), APP_PORT: values.APP_PORT || "", PORT: values.PORT || "" })).code, 0);
    }
  });
  const counterexample = { ...fixture, APP_PORT: "", PORT: "5000" };
  assert.equal(topology.evaluateLocalStoreTerminalTopology(counterexample).ok, baseline);
  assert.equal((await validator({ APP_PORT: "", PORT: "5000" })).code === 0, baseline);
});

test("explicit empty connection values override synthetic dotenv values", async t => {
  for (const [key, old] of [["APP_PORT", "4999"], ["TRUST_PROXY_HOPS", "1"], ["TRUST_PROXY_CIDRS", "127.0.0.1/8"],
    ["INTERNAL_APP_ORIGIN", "http://app:4173"], ["CORS_ALLOW_ORIGINS", "https://old.merchant.jp"],
    ["DEPLOYMENT_STAGE", "commercial"], ["COMMERCIAL_GO_MODE", "true"]]) {
    await t.test(key, () => assert.equal(loadedEnv({ [key]: "" }, `${key}=${old}\n`)[key], baseline ? old : ""));
  }
});

test("local preflight agrees with runtime on credentials and explicit proxy disable", async t => {
  for (const overrides of [{ APP_HOST: "http://u:p@127.0.0.1:4173" }, { PAY_BASE_URL: "http://u:p@127.0.0.1:4173" },
    { TRUST_PROXY: "" }, { TRUST_PROXY: "invalid" }, { TRUST_PROXY_CIDRS: "," }]) {
    await t.test(Object.keys(overrides).join(), async () => {
      assert.equal(topology.evaluateLocalStoreTerminalTopology({ ...fixture, ...overrides }).ok, false);
      assert.equal((await validator(overrides)).code === 0, baseline && !overrides.APP_HOST);
    });
  }
  if (!baseline) for (const TRUST_PROXY of ["false", "0", "no", "off", "FALSE"]) {
    await t.test(`disabled ${TRUST_PROXY}`, async () => {
      assert.equal(topology.evaluateLocalStoreTerminalTopology({ ...fixture, TRUST_PROXY }).ok, true);
      assert.equal((await validator({ TRUST_PROXY })).code, 0);
    });
  }
});

test("port alias boundaries and proxy inputs agree across preflight and topology", { skip: baseline }, async t => {
  for (const APP_ENV of ["production", "development"]) {
    for (const [APP_PORT, PORT, advertised, expected] of [
      ["", "80", 80, true], ["", "1", 1, true], ["", "65535", 65535, true],
      ["", "0", 4173, false], ["", "-1", 4173, false], ["", "65536", 4173, false],
      ["", "4.5", 4173, false], ["", "NaN", 4173, false], ["", " ", 4173, false],
      ["4173", "5000", 4173, true], ["4173", "NaN", 4173, true], ["0", "4173", 4173, false],
      ["04173", "", 4173, true], ["", "", 4173, true],
    ]) await t.test(`${APP_ENV} ports ${APP_PORT}/${PORT}`, async () => {
      const env = { APP_ENV, DEPLOYMENT_STAGE: "pilot", APP_PORT, PORT, ...originPort(advertised) };
      assert.equal(topology.evaluateLocalStoreTerminalTopology({ ...fixture, ...env }).ok, expected);
      assert.equal((await validator(env)).code === 0, expected);
    });
  }
  for (const overrides of [{ TRUST_PROXY: "true" }, { TRUST_PROXY: "1" }, { TRUST_PROXY: "yes" }, { TRUST_PROXY: "on" },
    { TRUST_PROXY_HOPS: "0" }, { TRUST_PROXY_HOPS: "1" }, { TRUST_PROXY_CIDRS: "127.0.0.1/8" }, { TRUST_PROXY_CIDRS: " , " }]) {
    await t.test(JSON.stringify(overrides), async () => {
      assert.equal(topology.evaluateLocalStoreTerminalTopology({ ...fixture, ...overrides }).ok, false);
      assert.notEqual((await validator(overrides)).code, 0);
    });
  }
});

test("actual dangerous-flags code exempts local direct listeners only", async t => {
  const fn = serverSource.match(/function evaluateDangerousFlagsGate\(\) \{[\s\S]*?\n\}/)[0];
  for (const APP_ENV of ["development", "production"]) for (const local of [true, false]) {
    await t.test(`${APP_ENV} local=${local}`, () => {
      const context = { APP_ENV, LOCAL_STORE_TERMINAL_TOPOLOGY: local, DEPLOYMENT_STAGE: "pilot", COMMERCIAL_GO_MODE: false,
        ENABLE_PUBLIC_PAYMENT_SIMULATION: false, DEMO_CONTROLS_ENABLED: false, DIAGNOSTIC_MODE_ENABLED: false,
        ALLOW_MANUAL_PAYMENT_INGEST: false, ENV: { WALLET_ADAPTER_TYPE: "wallet_deeplink" },
        WALLET_ADAPTER: { available: true, wallet_deeplink_template_configured: true },
        INTERNAL_APP_ORIGIN: "http://127.0.0.1:4173", APP_HOST: "http://127.0.0.1:4173",
        REFUND_TREASURY_ADDRESS: "0x" + "d".repeat(40), isEvmAddress: () => true,
        db: { prepare: () => ({ all: () => [] }) }, ENABLED_PAYMENT_CHAIN_IDS: ["137"],
        INSECURE_SECRETS: new Set(), APP_SECRET: "x".repeat(48), SERVICE_INGEST_SECRET: "y".repeat(48), METRICS_SECRET: "z".repeat(48),
        CORS_ALLOW_ORIGINS: ["http://127.0.0.1:4173"], TRUST_PROXY: false, TRUST_PROXY_CONFIGURED: false,
        SESSION_TTL_SEC: 3600, SSE_TOKEN_MAX_TTL_SEC: 300, PIN_LOCKOUT_MAX_ATTEMPTS: 5, PIN_LOCKOUT_SEC: 300,
        SERVICE_REPLAY_GUARD_TTL_SEC: 300, IDEMPOTENCY_TTL_SEC: 3600, PUBLIC_RATE_LIMIT_MAX: 100, LOGIN_RATE_LIMIT_MAX: 10,
        evaluateProxyRequirements: topology.evaluateProxyRequirements,
      };
      const result = vm.runInNewContext(`${fn};evaluateDangerousFlagsGate()`, context);
      const blockers = Array.from(result.blockers).filter(x => x.includes("TRUST_PROXY"));
      assert.equal(blockers.length, local && !baseline ? 0 : APP_ENV === "production" ? 2 : 1);
      if (local && !baseline) assert.equal(result.ok, true);
    });
  }
});

test("worker env loader retains production-like stage and GO flags for ingest safeguards", async t => {
  const source = fs.readFileSync("src/chain-monitor.mjs", "utf8");
  const defaults = source.match(/const DEFAULTS = \{[\s\S]*?\n\};/)[0];
  const loader = source.match(/function loadEnv\(\) \{[\s\S]*?\n\}/)[0];
  const gate = source.slice(source.indexOf("const APP_ENV ="), source.indexOf("const APP_HOST ="));
  for (const values of [{ DEPLOYMENT_STAGE: "pilot" }, { DEPLOYMENT_STAGE: "commercial" },
    ...["true", "1", "yes", "on", "TRUE"].map(COMMERCIAL_GO_MODE => ({ COMMERCIAL_GO_MODE }))]) {
    await t.test(JSON.stringify(values), () => {
      const result = vm.runInNewContext(`${defaults};${loader};const ENV = loadEnv();${gate};PRODUCTION_LIKE`, {
        fs: { existsSync: () => false }, path, CWD: "/synthetic", process: { env: { APP_ENV: "development", ...values } },
        isProductionLikeRuntime: topology.isProductionLikeRuntime,
        CONNECTION_ENV_KEYS: topology.CONNECTION_ENV_KEYS,
      });
      assert.equal(result, !baseline);
    });
  }
});

test("production and pilot HTTP readyz reflects the direct-listener gate", async t => {
  for (const APP_ENV of ["development", "production"]) await t.test(APP_ENV, async () => {
    const env = productionServerEnv({ APP_ENV, DEPLOYMENT_STAGE: "pilot", COMMERCIAL_GO_MODE: "false",
      DEPLOYMENT_TOPOLOGY: "local_store_terminal", TRUST_PROXY: "false", TRUST_PROXY_HOPS: "", TRUST_PROXY_CIDRS: "",
      PUBLIC_POLICY_ORIGIN: fixture.PUBLIC_POLICY_ORIGIN, PUBLIC_BASE_URL: fixture.PUBLIC_BASE_URL,
      PUBLIC_PAYMENT_PAGE_ENABLED: "false", BACKUP_DIR: "./synthetic-backups", RPC_URLS_137: fixture.RPC_URLS_137,
      LOCAL_TERMINAL_OPERATOR_READINESS_REF: "SYNTHETIC-MAC-READY" });
    Object.assign(env, originPort(env.APP_PORT));
    const proc = spawn(process.execPath, ["src/server.mjs"], { cwd: process.cwd(), env: { PATH: process.env.PATH, ...env } });
    const logs = [];proc.stdout.on("data", x => logs.push(String(x)));proc.stderr.on("data", x => logs.push(String(x)));
    try {
      await waitForServer(env.APP_HOST, proc, logs, 15000);
      const ready = await fetch(env.APP_HOST + "/readyz", { headers: { authorization: `Bearer ${env.METRICS_SECRET}` } });
      const payload = await ready.json();
      assert.equal(ready.status, 503, "unapproved business gates must remain fail-closed");
      assert.equal(payload.dangerous_flags_gate, !baseline, JSON.stringify(payload.blockers));
      assert.equal(payload.blockers.includes("dangerous_flags_gate"), baseline);
    } finally { await stopServerProcess(proc);fs.rmSync(path.dirname(env.DB_PATH), { recursive: true, force: true }); }
  });
});

test("PORT-only actual app and watcher reach the advertised loopback listener", { skip: baseline }, async () => {
  const env = productionServerEnv({ APP_ENV: "production", DEPLOYMENT_STAGE: "pilot", COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_TOPOLOGY: "local_store_terminal", TRUST_PROXY: "false", TRUST_PROXY_HOPS: "", TRUST_PROXY_CIDRS: "",
    PUBLIC_POLICY_ORIGIN: fixture.PUBLIC_POLICY_ORIGIN, PUBLIC_BASE_URL: fixture.PUBLIC_BASE_URL,
    PUBLIC_PAYMENT_PAGE_ENABLED: "false", BACKUP_DIR: "./synthetic-backups", RPC_URLS_137: fixture.RPC_URLS_137,
    LOCAL_TERMINAL_OPERATOR_READINESS_REF: "SYNTHETIC-MAC-READY" });
  const port = env.APP_PORT;Object.assign(env, originPort(port), { PORT: port });delete env.APP_PORT;
  const proc = spawn(process.execPath, ["src/server.mjs"], { cwd: process.cwd(), env: { PATH: process.env.PATH, ...env } });
  const logs = [];proc.stdout.on("data", x => logs.push(String(x)));proc.stderr.on("data", x => logs.push(String(x)));
  try { await waitForServer(env.APP_HOST, proc, logs, 15000);
    assert.equal((await fetch(env.INTERNAL_APP_ORIGIN + "/healthz")).status, 200);
    const db = new Database(env.WORKER_STATE_DB_PATH);
    db.exec("CREATE TABLE chain_monitor_state (key TEXT PRIMARY KEY, value TEXT)");
    for (const [key, value] of [["last_cycle_at", new Date().toISOString()], ["rpc_count", "1"], ["last_checkpoint", "SYNTHETIC"]]) {
      db.prepare("INSERT INTO chain_monitor_state VALUES (?, ?)").run(`worker:137:${key}`, value);
    }
    db.close();
    const watched = await new Promise(resolve => execFile(process.execPath, ["deploy/launchd/targets/health-watch.mjs"],
      { env: { PATH: process.env.PATH, ...env }, cwd: process.cwd() }, (error, stdout) => resolve({ code: error?.code ?? 0, body: JSON.parse(stdout) })));
    assert.equal(watched.code, 0, JSON.stringify(watched));
    assert.equal(watched.body.port, Number(port));
  } finally { await stopServerProcess(proc);fs.rmSync(path.dirname(env.DB_PATH), { recursive: true, force: true }); }
});

test("all loopback families work in production and pilot without trusting forwarded headers", { skip: baseline }, async t => {
  for (const APP_ENV of ["development", "production"]) for (const bind of ["127.0.0.1", "::1", "localhost"]) {
    await t.test(`${APP_ENV}/${bind}`, async () => {
      const env = productionServerEnv({ APP_ENV, DEPLOYMENT_STAGE: "pilot", COMMERCIAL_GO_MODE: "false",
        APP_BIND_HOST: bind, DEPLOYMENT_TOPOLOGY: "local_store_terminal", TRUST_PROXY: "false", TRUST_PROXY_HOPS: "", TRUST_PROXY_CIDRS: "",
        PUBLIC_POLICY_ORIGIN: fixture.PUBLIC_POLICY_ORIGIN, PUBLIC_BASE_URL: fixture.PUBLIC_BASE_URL,
        PUBLIC_PAYMENT_PAGE_ENABLED: "false", BACKUP_DIR: "./synthetic-backups", RPC_URLS_137: fixture.RPC_URLS_137,
        LOCAL_TERMINAL_OPERATOR_READINESS_REF: "SYNTHETIC-MAC-READY" });
      const origin = `http://${bind === "::1" ? "[::1]" : bind}:${env.APP_PORT}`;
      Object.assign(env, { APP_HOST: origin, PAY_BASE_URL: origin, INTERNAL_APP_ORIGIN: origin, CORS_ALLOW_ORIGINS: origin });
      const proc = spawn(process.execPath, ["src/server.mjs"], { cwd: process.cwd(), env: { PATH: process.env.PATH, ...env } });
      const logs = [];proc.stdout.on("data", x => logs.push(String(x)));proc.stderr.on("data", x => logs.push(String(x)));
      try {
        await waitForServer(origin, proc, logs, 15000);
        const ready = await fetch(origin + "/readyz", { headers: { authorization: `Bearer ${env.METRICS_SECRET}` } });
        assert.equal((await ready.json()).dangerous_flags_gate, true);
        const login = await fetch(origin + "/api/v1/terminal-sessions", { method: "POST",
          headers: { "content-type": "application/json", Origin: origin, "X-Forwarded-For": "198.51.100.99" },
          body: JSON.stringify({ terminalCode: env.BOOTSTRAP_TERMINAL_CODE, staffPin: env.BOOTSTRAP_ADMIN_PIN }) });
        assert.equal(login.status, 201);assert.equal(login.headers.get("access-control-allow-origin"), origin);
        const session = await login.json();
        const invoice = await fetch(origin + "/api/v1/invoices", { method: "POST",
          headers: { "content-type": "application/json", Origin: origin, authorization: `Bearer ${session.token}`, "idempotency-key": "synthetic-gate-check" },
          body: JSON.stringify({ amount_jpy: 1, payment_chain_id: "137" }) });
        const failure = await invoice.json();
        assert.equal(failure.error.code, "COMMERCIAL_GATE_BLOCKED", JSON.stringify(failure));
        assert.equal(failure.error.details.blockers.includes("dangerous_flags_gate"), false);
        const db = new Database(env.DB_PATH, { readonly: true });
        const logsWithIp = db.prepare("SELECT ip_address FROM audit_logs WHERE ip_address IS NOT NULL").all();
        assert.ok(logsWithIp.length > 0);assert.equal(logsWithIp.some(x => x.ip_address === "198.51.100.99"), false);
        db.close();
      } finally { await stopServerProcess(proc);fs.rmSync(path.dirname(env.DB_PATH), { recursive: true, force: true }); }
    });
  }
});
