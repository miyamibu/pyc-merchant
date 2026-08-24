import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import {
  baseServerEnv,
  productionServerEnv,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();
const PUBLIC_ORIGIN = "https://pay.miyamibu.xyz";

function spawnForExit(env) {
  const logs = [];
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: CWD,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => logs.push(String(chunk)));
  proc.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return { proc, logs };
}

function waitForExit(proc, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("server did not exit"));
    }, timeoutMs);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function productionLikeEnv(overrides = {}) {
  return productionServerEnv({
    APP_ENV: "development",
    COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_STAGE: "pilot",
    APP_HOST: PUBLIC_ORIGIN,
    PAY_BASE_URL: PUBLIC_ORIGIN,
    PUBLIC_BASE_URL: PUBLIC_ORIGIN,
    ...overrides,
  });
}

test("all production-like selectors reject missing, non-HTTPS, or mismatched public origins", async (t) => {
  const selectors = [
    { APP_ENV: "production", DEPLOYMENT_STAGE: "development", COMMERCIAL_GO_MODE: "false" },
    { APP_ENV: "development", DEPLOYMENT_STAGE: "pilot", COMMERCIAL_GO_MODE: "false" },
    { APP_ENV: "development", DEPLOYMENT_STAGE: "commercial", COMMERCIAL_GO_MODE: "false" },
    { APP_ENV: "development", DEPLOYMENT_STAGE: "development", COMMERCIAL_GO_MODE: "true" },
  ];
  const invalidOrigins = [
    { APP_HOST: "http://pay.miyamibu.xyz", PAY_BASE_URL: PUBLIC_ORIGIN, PUBLIC_BASE_URL: PUBLIC_ORIGIN },
    { APP_HOST: PUBLIC_ORIGIN, PAY_BASE_URL: "", PUBLIC_BASE_URL: PUBLIC_ORIGIN },
    { APP_HOST: PUBLIC_ORIGIN, PAY_BASE_URL: "https://other.miyamibu.xyz", PUBLIC_BASE_URL: PUBLIC_ORIGIN },
  ];
  for (const selector of selectors) {
    for (const invalid of invalidOrigins) {
      await t.test(`${JSON.stringify(selector)} ${JSON.stringify(invalid)}`, async () => {
        const env = baseServerEnv({ ...selector, ...invalid });
        const started = spawnForExit(env);
        const exit = await waitForExit(started.proc);
        assert.notEqual(exit.code, 0);
        assert.match(started.logs.join(""), /public HTTPS URL|explicitly configured|same public origin/i);
      });
    }
  }
});

test("pilot and commercial stages require explicit bootstrap and never create demo identities", async (t) => {
  for (const stage of ["pilot", "commercial"]) {
    await t.test(stage, async () => {
      const env = productionLikeEnv({
        DEPLOYMENT_STAGE: stage,
        BOOTSTRAP_ADMIN_PIN: "",
        BOOTSTRAP_TERMINAL_CODE: "",
      });
      const started = spawnForExit(env);
      const exit = await waitForExit(started.proc);
      assert.notEqual(exit.code, 0);
      assert.match(started.logs.join(""), /bootstrap requires non-default BOOTSTRAP_ADMIN_PIN/i);

      const db = new Database(env.DB_PATH, { readonly: true });
      try {
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM terminals WHERE id = 'terminal-001'").get().count, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_users WHERE id IN ('staff-001', 'staff-002')").get().count, 0);
      } finally {
        db.close();
      }
    });
  }
});

test("production-like explicit bootstrap creates only bootstrap identities", async (t) => {
  const env = productionLikeEnv();
  const started = await startServerProcess(CWD, env);
  t.after(async () => stopServerProcess(started.proc));
  const db = new Database(env.DB_PATH, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM terminals WHERE id = 'terminal-bootstrap'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_users WHERE id = 'staff-bootstrap'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM terminals WHERE id = 'terminal-001'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_users WHERE id IN ('staff-001', 'staff-002')").get().count, 0);
  } finally {
    db.close();
  }
});
