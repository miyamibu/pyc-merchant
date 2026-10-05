import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { isPublicHttpsOriginOnly, resolvePublicPolicyOrigin } from "../src/deployment-topology.mjs";
import { productionServerEnv, waitForServer, stopServerProcess } from "./helpers/server-process.mjs";

const valid = "https://policies.merchant.jp";
const rejected = ["https://8.8.8.8", "https://0x08080808", "https://134744072", "https://[2606:4700:4700::1111]",
  "https://127.0.0.1", "https://localhost", "https://merchant.local", "https://merchant.test",
  "https://merchant.invalid", "https://merchant.example", "https://merchant.arpa", "https://foo.example.com",
  "https://EXAMPLE.ORG.", "https://example.net", "https://singlehost", "http://policies.merchant.jp",
  "https://user:pass@policies.merchant.jp", "https://policies.merchant.jp:8443", valid + "/terms", valid + "/?q=1", valid + "/#fragment"];
const accepted = [valid, valid + "/", "HTTPS://POLICIES.MERCHANT.JP:443", "https://policies.merchant.jp."];

function fixture(t) {
  const env = productionServerEnv({ DEPLOYMENT_STAGE: "pilot", COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_TOPOLOGY: "local_store_terminal", TRUST_PROXY: "false", TRUST_PROXY_HOPS: "", TRUST_PROXY_CIDRS: "",
    PUBLIC_PAYMENT_PAGE_ENABLED: "false", CHAIN_ID: "137", ENABLED_PAYMENT_CHAIN_IDS: "137",
    LOCAL_TERMINAL_OPERATOR_READINESS_REF: "SYNTHETIC", RPC_URLS_137: "https://rpc.merchant.jp" });
  const origin = `http://127.0.0.1:${env.APP_PORT}`;
  Object.assign(env, { APP_HOST: origin, PAY_BASE_URL: origin, INTERNAL_APP_ORIGIN: origin, CORS_ALLOW_ORIGINS: origin,
    PUBLIC_POLICY_ORIGIN: valid, PUBLIC_BASE_URL: valid, BACKUP_DIR: path.join(path.dirname(env.DB_PATH), "backups") });
  t.after(() => fs.rmSync(path.dirname(env.DB_PATH), { recursive: true, force: true }));
  return { PATH: process.env.PATH, ...env };
}
function preflight(env) {
  const result = spawnSync(process.execPath, ["scripts/production-validation/validate-production-config.mjs", "--skip-rpc", "--allow-empty"],
    { env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined);
  return { code: result.status, body: JSON.parse(result.stdout) };
}

test("shared public-policy origin boundary preserves canonical origins and rejects alternate encodings", () => {
  for (const origin of accepted) {
    assert.equal(isPublicHttpsOriginOnly(origin), true, origin);
    assert.equal(resolvePublicPolicyOrigin({ PUBLIC_POLICY_ORIGIN: origin }).origin, new URL(origin).origin);
    assert.equal(resolvePublicPolicyOrigin({ PUBLIC_BASE_URL: origin }).source, "PUBLIC_BASE_URL");
  }
  for (const origin of rejected) {
    assert.equal(isPublicHttpsOriginOnly(origin), false, origin);
    assert.equal(resolvePublicPolicyOrigin({ PUBLIC_POLICY_ORIGIN: origin, PUBLIC_BASE_URL: valid }), null, "invalid official cannot fall back: " + origin);
    assert.equal(resolvePublicPolicyOrigin({ PUBLIC_BASE_URL: origin }), null, origin);
  }
});

test("actual preflight and production runtime reject the same policy-origin matrix before opening a ledger", async t => {
  const env = fixture(t);
  for (const key of ["PUBLIC_POLICY_ORIGIN", "PUBLIC_BASE_URL"]) for (const origin of rejected) {
    const probe = { ...env, PUBLIC_POLICY_ORIGIN: key === "PUBLIC_POLICY_ORIGIN" ? origin : "", PUBLIC_BASE_URL: key === "PUBLIC_BASE_URL" ? origin : valid };
    const checked = preflight(probe);
    assert.equal(checked.code, 1, `${key}=${origin}`); assert.equal(checked.body.ok, false);
    assert.match(checked.body.checks.at(-1).message, /PUBLIC_POLICY_ORIGIN|policy\/Site origin/i);
    const runtime = spawnSync(process.execPath, ["src/server.mjs"], { env: probe, encoding: "utf8", timeout: 10000 });
    assert.equal(runtime.error, undefined); assert.equal(runtime.status, 1, `${key}=${origin}: ${runtime.stderr}`);
    assert.match(runtime.stderr, /FATAL:.*PUBLIC_POLICY_ORIGIN.*origin-only public HTTPS/);
    assert.equal(fs.existsSync(env.DB_PATH), false, "invalid origin must fail before creating the test ledger");
  }
});

test("official and legacy origin keys both pass actual preflight and production startup for canonical public origins", async t => {
  for (const key of ["PUBLIC_POLICY_ORIGIN", "PUBLIC_BASE_URL"]) for (const origin of accepted) {
    await t.test(`${key}=${origin}`, async t => {
      const env = fixture(t);
      Object.assign(env, { PUBLIC_POLICY_ORIGIN: key === "PUBLIC_POLICY_ORIGIN" ? origin : "", PUBLIC_BASE_URL: origin });
      const checked = preflight(env); assert.equal(checked.code, 0, JSON.stringify(checked.body)); assert.equal(checked.body.ok, true);
      const proc = spawn(process.execPath, ["src/server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
      const logs = []; proc.stdout.on("data", x => logs.push(String(x))); proc.stderr.on("data", x => logs.push(String(x)));
      try { await waitForServer(env.APP_HOST, proc, logs, 15000); assert.equal((await fetch(env.APP_HOST + "/healthz")).status, 200); }
      finally { await stopServerProcess(proc); }
    });
  }
});

test("conflicting fallback origin cannot override the official origin", t => {
  const env = fixture(t); env.PUBLIC_BASE_URL = "https://other.merchant.jp";
  const checked = preflight(env); assert.equal(checked.code, 1);
  const runtime = spawnSync(process.execPath, ["src/server.mjs"], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(runtime.error, undefined); assert.equal(runtime.status, 1);
  assert.match(runtime.stderr, /public_base_url_policy_origin_mismatch/i); assert.equal(fs.existsSync(env.DB_PATH), false);
});
