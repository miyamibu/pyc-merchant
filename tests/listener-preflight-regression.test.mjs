import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { evaluateLocalStoreTerminalTopology } from "../src/deployment-topology.mjs";

const fixture = {
  APP_ENV: "production", DEPLOYMENT_TOPOLOGY: "local_store_terminal", APP_BIND_HOST: "127.0.0.1", APP_PORT: "4173",
  APP_HOST: "http://127.0.0.1:4173", PAY_BASE_URL: "http://127.0.0.1:4173", INTERNAL_APP_ORIGIN: "http://127.0.0.1:4173",
  CORS_ALLOW_ORIGINS: "http://127.0.0.1:4173", PUBLIC_POLICY_ORIGIN: "https://policies.merchant.jp", PUBLIC_BASE_URL: "https://policies.merchant.jp",
  PUBLIC_PAYMENT_PAGE_ENABLED: "false", TRUST_PROXY: "false", DB_PATH: "./synthetic-ledger.db", WORKER_STATE_DB_PATH: "./synthetic-worker.db",
  BACKUP_DIR: "./synthetic-backups", CHAIN_ID: "137", ENABLED_PAYMENT_CHAIN_IDS: "137", RPC_URLS_137: "https://rpc.merchant.jp",
  TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29", APPROVED_JPYC_TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
  TOKEN_DECIMALS: "18", RECIPIENT_ADDRESS: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", WALLET_ADAPTER_TYPE: "wallet_deeplink",
  LOCAL_TERMINAL_OPERATOR_READINESS_REF: "SYNTHETIC-MAC-READY",
};
function origins(bind, port, advertisedHost = bind) {
  const host = advertisedHost.includes(":") ? `[${advertisedHost}]` : advertisedHost;
  const origin = `http://${host}${Number(port) === 80 ? "" : `:${Number(port)}`}`;
  return { APP_BIND_HOST: bind, APP_PORT: String(port), APP_HOST: origin, PAY_BASE_URL: origin,
    INTERNAL_APP_ORIGIN: origin, CORS_ALLOW_ORIGINS: new URL(origin).origin };
}
async function gates(overrides, expected) {
  const env = { ...fixture, ...overrides };
  const runtime = evaluateLocalStoreTerminalTopology(env);
  const cli = await new Promise((resolve) => execFile(process.execPath,
    ["scripts/production-validation/validate-production-config.mjs", "--skip-rpc", "--allow-empty"],
    { cwd: process.cwd(), env: { PATH: process.env.PATH, ...env } },
    (error, stdout) => resolve({ code: error?.code ?? 0, result: JSON.parse(stdout) })));
  assert.equal(runtime.ok, expected, JSON.stringify(runtime));
  assert.equal(cli.code === 0, expected, JSON.stringify(cli.result));
}

test("listener mismatch rejects host-family and port drift in runtime and preflight", async (t) => {
  for (const [bind, host] of [["::1", "127.0.0.1"], ["127.0.0.1", "::1"], ["localhost", "127.0.0.1"], ["127.0.0.1", "localhost"]]) {
    await t.test(`${bind} cannot advertise ${host}`, () => gates(origins(bind, 4173, host), false));
  }
  await t.test("original P1 host and port counterexample", () => gates({ ...origins("::1", 4999, "127.0.0.1"), APP_PORT: "4173" }, false));
  for (const key of ["APP_HOST", "PAY_BASE_URL", "INTERNAL_APP_ORIGIN"]) {
    await t.test(`${key} wrong port`, () => gates({ [key]: "http://127.0.0.1:4999" }, false));
  }
  for (const APP_PORT of ["0", "-1", "65536", "4173.5", "NaN", "Infinity"]) {
    await t.test(`invalid APP_PORT ${APP_PORT}`, () => gates({ APP_PORT }, false));
  }
  await t.test("omitted URL port is 80, not the default listener 4173", () => gates({ ...origins("127.0.0.1", 80), APP_PORT: "" }, false));
});

test("bind-only bracket syntax and external binds fail both gates", async (t) => {
  for (const APP_BIND_HOST of ["[::1]", "::", "0.0.0.0", "", "LOCALHOST", "::1]", "[::1"]) {
    await t.test(APP_BIND_HOST || "missing", () => gates({ APP_BIND_HOST }, false));
  }
});

test("all supported listener families and valid port boundaries remain accepted", async (t) => {
  for (const bind of ["127.0.0.1", "::1", "localhost"]) {
    for (const port of [1, 80, 4173, 65535]) await t.test(`${bind}:${port}`, () => gates(origins(bind, port), true));
  }
  await t.test("default APP_PORT 4173", () => gates({ APP_PORT: "" }, true));
  await t.test("integer port with leading zero", () => gates({ APP_PORT: "04173" }, true));
  await t.test("canonical expanded IPv6 URL", () => gates(origins("::1", 4173, "0:0:0:0:0:0:0:1"), true));
});

test("policy fallback is validated before resolution discards it", async (t) => {
  for (const PUBLIC_BASE_URL of ["https://different.merchant.jp", "http://policies.merchant.jp", "https://policies.merchant.jp/path",
    "https://user:pass@policies.merchant.jp", "https://policies.merchant.jp:444", "https://policies.merchant.jp?q=1"]) {
    await t.test(PUBLIC_BASE_URL, () => gates({ PUBLIC_BASE_URL }, false));
  }
  for (const overrides of [{ PUBLIC_BASE_URL: "" }, { PUBLIC_POLICY_ORIGIN: "" },
    { PUBLIC_BASE_URL: "https://policies.merchant.jp/" }, { PUBLIC_POLICY_ORIGIN: "https://policies.merchant.jp/" }]) {
    await t.test(JSON.stringify(overrides), () => gates(overrides, true));
  }
});

test("advertised matching origins actually reach all three loopback listeners", async (t) => {
  for (const bind of ["127.0.0.1", "::1", "localhost"]) await t.test(bind, async () => {
    const server = http.createServer((_req, res) => res.end("synthetic-listener-ok"));
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ port: 0, host: bind }, resolve); });
      const env = origins(bind, server.address().port);
      await gates(env, true);
      for (const key of ["APP_HOST", "PAY_BASE_URL", "INTERNAL_APP_ORIGIN"]) {
        const response = await fetch(env[key]);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "synthetic-listener-ok");
      }
    } finally { if (server.listening) await new Promise((resolve) => server.close(resolve)); }
  });
});
