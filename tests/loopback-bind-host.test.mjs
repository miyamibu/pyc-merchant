import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import vm from "node:vm";
import {
  evaluateLocalStoreTerminalTopology,
  isLoopbackBindHost,
  isLoopbackHost,
  parseDeploymentTopology,
} from "../src/deployment-topology.mjs";

// Configuration strings only: no RPC, wallet, DB or backup is opened.
const fixture = {
  APP_BIND_HOST: "127.0.0.1",
  PUBLIC_POLICY_ORIGIN: "https://policies.merchant.jp",
  APP_HOST: "http://127.0.0.1:4173",
  PAY_BASE_URL: "http://127.0.0.1:4173",
  TRUST_PROXY: "false",
  PUBLIC_PAYMENT_PAGE_ENABLED: "false",
  WALLET_ADAPTER_TYPE: "wallet_deeplink",
  RECIPIENT_ADDRESS: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  CHAIN_ID: "137",
  ENABLED_PAYMENT_CHAIN_IDS: "137",
  RPC_URLS_137: "https://rpc.merchant.jp",
  BACKUP_DIR: "./fixture-backups",
  WORKER_STATE_DB_PATH: "./fixture-worker-state.db",
  LOCAL_TERMINAL_OPERATOR_READINESS_REF: "SYNTHETIC-MAC-READY",
};

test("bind validation accepts only raw loopback hosts", () => {
  for (const APP_BIND_HOST of ["127.0.0.1", "::1", "localhost"]) {
    assert.equal(isLoopbackBindHost(APP_BIND_HOST), true);
    assert.deepEqual(evaluateLocalStoreTerminalTopology({ ...fixture, APP_BIND_HOST }).blockers, []);
  }
});

test("bracketed IPv6 produces an actionable startup blocker", () => {
  const result = evaluateLocalStoreTerminalTopology({ ...fixture, APP_BIND_HOST: "[::1]" });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("topology_local_requires_loopback_bind_host"));
  assert.ok(result.blockers.includes("topology_local_bind_host_must_be_unbracketed"));
  assert.equal(isLoopbackBindHost("[::1]"), false);
});

test("external, wildcard and malformed bind hosts remain rejected", () => {
  for (const APP_BIND_HOST of ["0.0.0.0", "::", "192.168.1.10", "8.8.8.8", "merchant.jp", "[127.0.0.1]", "::1]", "[::1", "LOCALHOST"]) {
    assert.equal(isLoopbackBindHost(APP_BIND_HOST), false, APP_BIND_HOST);
    assert.ok(evaluateLocalStoreTerminalTopology({ ...fixture, APP_BIND_HOST }).blockers.includes("topology_local_requires_loopback_bind_host"), APP_BIND_HOST);
  }
});

test("IPv6 URL origins retain their existing bracket handling", () => {
  assert.equal(isLoopbackHost(new URL("http://[::1]:4173").hostname), true);
  const result = evaluateLocalStoreTerminalTopology({
    ...fixture, APP_BIND_HOST: "::1", APP_HOST: "http://[::1]:4173", PAY_BASE_URL: "http://[::1]:4173",
  });
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
});

test("missing local bind hosts remain fail-closed and public topology stays the default", () => {
  assert.equal(parseDeploymentTopology(undefined), "public_cloud");
  for (const APP_BIND_HOST of [undefined, ""]) {
    assert.ok(evaluateLocalStoreTerminalTopology({ ...fixture, APP_BIND_HOST }).blockers.includes("topology_local_requires_loopback_bind_host"));
  }
});

test("the existing listener preserves its default-host branch and raw IPv6 argument", () => {
  const server = fs.readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  const source = server.match(/export function startServer\(\) \{[\s\S]*?\n\}/)?.[0].replace(/^export /, "");
  assert.ok(source);
  for (const APP_BIND_HOST of ["", "::1"]) {
    let passed;
    const start = vm.runInNewContext(`let serverInstance = null; ${source}; startServer`, {
      APP_BIND_HOST, PORT: 4173,
      app: { listen: (...args) => { passed = args; return {}; } },
    });
    start();
    assert.equal(passed[0], 4173);
    if (APP_BIND_HOST) {
      assert.equal(passed.length, 3);
      assert.equal(passed[1], "::1");
    } else {
      assert.equal(passed.length, 2);
      assert.equal(typeof passed[1], "function");
    }
  }
});

test("raw IPv6 loopback is accepted by the actual Node listener", async () => {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: 0, host: "::1" }, resolve);
    });
    assert.equal(server.address().address, "::1");
    assert.equal(server.address().family, "IPv6");
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});
