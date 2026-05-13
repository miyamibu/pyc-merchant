import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

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

test("validate-production-config passes for production-safe env with skip-rpc", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--skip-rpc"],
    {
      APP_ENV: "production",
      APP_HOST: "https://terminal.example.com",
      PUBLIC_BASE_URL: "https://terminal.example.com",
      PAY_BASE_URL: "https://terminal.example.com",
      CORS_ALLOW_ORIGINS: "https://terminal.example.com",
      CHAIN_ID: "137",
      TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
      APPROVED_JPYC_TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
      TOKEN_DECIMALS: "18",
      RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
      WALLET_DEEPLINK_TEMPLATE: "wallet://open?uri={{payment_uri_encoded}}",
    }
  );
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.some((row) => row.name === "chain_id_polygon" && row.ok === true));
});

test("validate-production-config fails on chain drift", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--skip-rpc"],
    {
      APP_ENV: "production",
      APP_HOST: "https://terminal.example.com",
      PUBLIC_BASE_URL: "https://terminal.example.com",
      PAY_BASE_URL: "https://terminal.example.com",
      CHAIN_ID: "1",
      TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
      APPROVED_JPYC_TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
      TOKEN_DECIMALS: "18",
      RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
    }
  );
  assert.notEqual(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(JSON.stringify(payload), /CHAIN_ID must be 137/);
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
