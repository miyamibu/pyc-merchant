import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

const ROOT = process.cwd();
const OFFICIAL_JPYC_CONTRACT = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";

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
      APP_HOST: "https://terminal.miyamibu.jp",
      PUBLIC_BASE_URL: "https://terminal.miyamibu.jp",
      PAY_BASE_URL: "https://terminal.miyamibu.jp",
      INTERNAL_API_BASE_URL: "http://app:4173",
      CORS_ALLOW_ORIGINS: "https://terminal.miyamibu.jp",
      CHAIN_ID: "137",
      TOKEN_CONTRACT: OFFICIAL_JPYC_CONTRACT,
      APPROVED_JPYC_TOKEN_CONTRACT: OFFICIAL_JPYC_CONTRACT,
      TOKEN_DECIMALS: "18",
      RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
      WALLET_DEEPLINK_TEMPLATE: "wallet://open?uri={{payment_uri_encoded}}",
      PUBLIC_LINK_GRACE_SEC: "900",
      TERMS_URL: "https://terminal.miyamibu.jp/legal/terms",
      PRIVACY_URL: "https://terminal.miyamibu.jp/legal/privacy",
      REFUND_POLICY_URL: "https://terminal.miyamibu.jp/legal/refund",
      TERMS_VERSION: "terms-2026-05",
      PRIVACY_VERSION: "privacy-2026-05",
      REFUND_POLICY_VERSION: "refund-2026-05",
    }
  );
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.some((row) => row.name === "chain_id_supported_jpyc" && row.ok === true));
});

test("validate-production-config fails on chain drift", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--skip-rpc"],
    {
      APP_ENV: "production",
      APP_HOST: "https://terminal.miyamibu.jp",
      PUBLIC_BASE_URL: "https://terminal.miyamibu.jp",
      PAY_BASE_URL: "https://terminal.miyamibu.jp",
      INTERNAL_API_BASE_URL: "http://app:4173",
      CHAIN_ID: "999",
      TOKEN_CONTRACT: OFFICIAL_JPYC_CONTRACT,
      APPROVED_JPYC_TOKEN_CONTRACT: OFFICIAL_JPYC_CONTRACT,
      TOKEN_DECIMALS: "18",
      RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
      PUBLIC_LINK_GRACE_SEC: "900",
      TERMS_URL: "https://terminal.miyamibu.jp/legal/terms",
      PRIVACY_URL: "https://terminal.miyamibu.jp/legal/privacy",
      REFUND_POLICY_URL: "https://terminal.miyamibu.jp/legal/refund",
      TERMS_VERSION: "terms-2026-05",
      PRIVACY_VERSION: "privacy-2026-05",
      REFUND_POLICY_VERSION: "refund-2026-05",
    }
  );
  assert.notEqual(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(JSON.stringify(payload), /CHAIN_ID must be one of 1, 43114, 137/);
});

test("validate-production-config does not require policy URLs for ordinary dev validation", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--skip-rpc", "--app-env", "development"],
    {
      APP_ENV: "development",
      APP_HOST: "http://127.0.0.1:4173",
      PUBLIC_LINK_GRACE_SEC: "900",
    }
  );
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.some((row) => row.name === "policy_config_public_and_versioned" && row.skipped === true));
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

test("validate-evidence-sanitization allows public token contract evidence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-evidence-token-contract-"));
  fs.writeFileSync(path.join(dir, "contract.json"), JSON.stringify({ token_contract: OFFICIAL_JPYC_CONTRACT }), "utf8");
  const result = await runNode("scripts/production-validation/validate-evidence-sanitization.mjs", ["--evidence-dir", dir], {
    APP_SECRET: "x".repeat(48),
    TOKEN_CONTRACT: OFFICIAL_JPYC_CONTRACT,
  });
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
});

test("validate-evidence-sanitization rejects database files in evidence artifacts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-evidence-db-artifact-"));
  fs.writeFileSync(path.join(dir, "app.sqlite3"), "not-a-real-db", "utf8");
  const result = await runNode("scripts/production-validation/validate-evidence-sanitization.mjs", ["--evidence-dir", dir]);
  assert.notEqual(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.violations[0].reason, "database_file_in_sanitized_evidence");
});

test("ci uploads timestamped production evidence directory instead of backup directories", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /find artifacts\/production-validation-evidence .* -name '20\*T\*Z'/);
  assert.doesNotMatch(workflow, /find artifacts\/production-validation-evidence -mindepth 1 -maxdepth 1 -type d \| sort \| tail -n 1/);
});

test("validate-evidence-sanitization accepts sanitized manifest and rejects sensitive manifest", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-manifest-test-"));
  const manifestPath = path.join(dir, "release.json");
  const manifest = {
    release_id: "rel-2026-05",
    commit_sha: "abcdef1234567890",
    artifact_storage_ref: "s3://redacted-bucket/releases/rel-2026-05",
    artifact_hashes: { "EXT-001": "a".repeat(64) },
    external_statuses: { "EXT-001": "pending", "EXT-002": "pending", "EXT-003": "pending", "EXT-004": "pending" },
    reviewer_refs: ["review-1"],
    approver_refs: ["approval-1"],
    signed_minutes_ref: "minutes-1",
    sbom_ref: "sbom-1",
    image_scan_ref: "image-scan-1",
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const ok = await runNode("scripts/production-validation/validate-evidence-sanitization.mjs", ["--manifest", manifestPath]);
  assert.equal(ok.code, 0, ok.stdout || ok.stderr);

  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, artifact_storage_ref: "authorization: Bearer leak" }, null, 2), "utf8");
  const bad = await runNode("scripts/production-validation/validate-evidence-sanitization.mjs", ["--manifest", manifestPath]);
  assert.notEqual(bad.code, 0);
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
