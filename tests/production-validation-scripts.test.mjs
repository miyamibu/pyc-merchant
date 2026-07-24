import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { startMockRpcServer } from "./helpers/mock-rpc.mjs";

const ROOT = process.cwd();

function runNode(scriptPath, args = [], env = {}) {
  return new Promise((resolve) => {
    execFile(
      "node",
      [scriptPath, ...args],
      {
        cwd: ROOT,
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      }
    );
  });
}

test("validate-production-config passes template preflight with explicitly allowed RPC skip", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--skip-rpc", "--allow-empty"],
    {
      APP_ENV: "production",
      APP_BIND_HOST: "127.0.0.1",
      TRUST_PROXY: "true",
      TRUST_PROXY_HOPS: "1",
      APP_HOST: "https://terminal.example.com",
      PUBLIC_BASE_URL: "https://terminal.example.com",
      PAY_BASE_URL: "https://terminal.example.com",
      CORS_ALLOW_ORIGINS: "https://terminal.example.com",
      CHAIN_ID: "137",
      TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      APPROVED_JPYC_TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      TOKEN_DECIMALS: "18",
      RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
    }
  );
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.some((row) => row.name === "payment_chain_enabled" && row.ok === true));
  assert.ok(payload.checks.some((row) => (
    row.name === "wallet_payload_chain"
    && row.expected_amount_atomic === "1000000000000000000"
  )));
});

test("validate-production-config rejects RPC skip for non-template production validation", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--skip-rpc"],
    {
      APP_ENV: "production",
      APP_BIND_HOST: "127.0.0.1",
      TRUST_PROXY: "true",
      TRUST_PROXY_HOPS: "1",
      APP_HOST: "https://terminal.example.com",
      PUBLIC_BASE_URL: "https://terminal.example.com",
      PAY_BASE_URL: "https://terminal.example.com",
      CORS_ALLOW_ORIGINS: "https://terminal.example.com",
      CHAIN_ID: "137",
      TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      APPROVED_JPYC_TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      TOKEN_DECIMALS: "18",
      JPYC_BASE_UNIT_SCALE: "1000000",
      APPROVED_TOKEN_NAME: "JPYC",
      APPROVED_TOKEN_CODE_HASH: `0x${"1".repeat(64)}`,
      APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH: `0x${"2".repeat(64)}`,
      RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
    }
  );
  assert.notEqual(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(JSON.stringify(payload), /--skip-rpc is not allowed/);
});

test("validate-production-config verifies token metadata on every configured RPC endpoint", async (t) => {
  const rpc = await startMockRpcServer({ chainId: 137, tokenDecimals: 18 });
  t.after(() => rpc.stop());
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    [],
    {
      APP_ENV: "development",
      APP_HOST: "http://127.0.0.1:4173",
      PUBLIC_BASE_URL: "http://127.0.0.1:4173",
      PAY_BASE_URL: "http://127.0.0.1:4173",
      CHAIN_ID: "137",
      TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      APPROVED_JPYC_TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      TOKEN_SYMBOL: "JPYC",
      TOKEN_DECIMALS: "18",
      JPYC_BASE_UNIT_SCALE: "1000000",
      RPC_URLS: rpc.url,
    }
  );
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  const metadataCheck = payload.checks.find((row) => row.name === "rpc_token_metadata");
  assert.equal(metadataCheck?.ok, true);
  assert.equal(metadataCheck?.configured_count, 1);
  assert.equal(metadataCheck?.verified_count, 1);
  assert.equal(metadataCheck?.endpoints?.[0]?.observed?.decimals, 18);
  assert.equal(metadataCheck?.endpoints?.[0]?.observed?.symbol, "JPYC");
});

test("validate-production-config quarantines an RPC endpoint with mismatched token decimals", async (t) => {
  const rpc = await startMockRpcServer({ chainId: 137, tokenDecimals: 6 });
  t.after(() => rpc.stop());
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    [],
    {
      APP_ENV: "development",
      APP_HOST: "http://127.0.0.1:4173",
      PUBLIC_BASE_URL: "http://127.0.0.1:4173",
      PAY_BASE_URL: "http://127.0.0.1:4173",
      CHAIN_ID: "137",
      TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      APPROVED_JPYC_TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      TOKEN_SYMBOL: "JPYC",
      TOKEN_DECIMALS: "18",
      JPYC_BASE_UNIT_SCALE: "1000000",
      RPC_URLS: rpc.url,
    }
  );
  assert.notEqual(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(JSON.stringify(payload), /TOKEN_DECIMALS_MISMATCH/);
  assert.match(JSON.stringify(payload), /quarantined/);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(rpc.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("validate-production-config fails on chain drift", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--skip-rpc"],
    {
      APP_ENV: "production",
      APP_BIND_HOST: "127.0.0.1",
      TRUST_PROXY: "true",
      TRUST_PROXY_HOPS: "1",
      APP_HOST: "https://terminal.example.com",
      PUBLIC_BASE_URL: "https://terminal.example.com",
      PAY_BASE_URL: "https://terminal.example.com",
      CHAIN_ID: "10",
      TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      APPROVED_JPYC_TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      TOKEN_DECIMALS: "18",
      RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
    }
  );
  assert.notEqual(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(JSON.stringify(payload), /CHAIN_ID must be an enabled JPYC chain/);
});

test("validate-evidence-sanitization rejects leaked bearer token", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-evidence-test-"));
  fs.writeFileSync(path.join(dir, "bad.log"), "authorization: Bearer super-secret-token\n", "utf8");
  const result = await runNode("scripts/production-validation/validate-evidence-sanitization.mjs", ["--evidence-dir", dir], {
    APP_SECRET: "x".repeat(48),
  });
  assert.notEqual(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.violation_count, 1);
});

test("run-commercial-validate-safe writes reports under a safe output base", async () => {
  const safeBase = mkdtempSync(path.join(tmpdir(), "jpyc-commercial-safe-"));
  const evidenceRoot = mkdtempSync(path.join(tmpdir(), "jpyc-commercial-evidence-"));
  const result = await runNode(
    "scripts/production-validation/run-commercial-validate-safe.mjs",
    ["--output-base", safeBase, "--evidence-root", evidenceRoot]
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(String(payload.output_dir || "").startsWith(safeBase));
  assert.ok(fs.existsSync(path.join(payload.output_dir, "commercial-go-validation.json")));
  assert.ok(fs.existsSync(path.join(payload.output_dir, "COMMERCIAL_GO_SUMMARY.md")));
});
