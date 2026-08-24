import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = process.cwd();

function runNode(scriptPath, args = [], env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
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

test("commercial validation generates JSON, scorecard, and summary without fake pass", async () => {
  const evidenceRoot = mkdtempSync(path.join(tmpdir(), "jpyc-commercial-validate-"));
  const latestDir = path.join(evidenceRoot, "20260422T000000Z");
  fs.mkdirSync(latestDir, { recursive: true });
  fs.writeFileSync(path.join(latestDir, "EXT-001-real-jpyc-payment.md"), "- status: pending\n", "utf8");
  fs.writeFileSync(path.join(latestDir, "EXT-002-wallet-device-launch.md"), "- status: pending\n", "utf8");
  fs.writeFileSync(path.join(latestDir, "EXT-003-public-fqdn-tls.md"), "- status: pending\n", "utf8");
  fs.writeFileSync(path.join(latestDir, "EXT-004-store-ops-drill.md"), "- status: pending\n", "utf8");

  const outputDir = mkdtempSync(path.join(tmpdir(), "jpyc-commercial-out-"));
  const result = await runNode("scripts/production-validation/validate-commercial-go.mjs", [
    "--evidence-root",
    evidenceRoot,
    "--output-dir",
    outputDir,
  ], {
    APP_ENV: "development",
    COMMERCIAL_GO_MODE: "false",
    DB_PATH: "./data/app.db",
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed.verdict, "string");
  assert.ok(parsed.verdict !== "COMMERCIAL_GO_10");
  assert.equal(fs.existsSync(path.join(outputDir, "commercial-go-validation.json")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "COMMERCIAL_GO_SUMMARY.md")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "commercial-go-scorecard.md")), true);
  assert.equal(parsed.scorecard, path.join(outputDir, "commercial-go-scorecard.md"));

  const report = JSON.parse(fs.readFileSync(path.join(outputDir, "commercial-go-validation.json"), "utf8"));
  assert.equal(report.commercial_10_ready, false);
  assert.ok(Array.isArray(report.blockers.P0));
});

test("real-money release gates reject latest evidence auto-selection and conditional waivers", async () => {
  const evidenceRoot = mkdtempSync(path.join(tmpdir(), "jpyc-latest-evidence-"));
  const latestDir = path.join(evidenceRoot, "20260422T000000Z");
  fs.mkdirSync(latestDir, { recursive: true });
  fs.writeFileSync(path.join(latestDir, "EXT-001-real-jpyc-payment.md"), "- status: pass\n", "utf8");

  const outputDir = mkdtempSync(path.join(tmpdir(), "jpyc-latest-out-"));
  const result = await runNode("scripts/production-validation/validate-commercial-go.mjs", [
    "--evidence-root",
    evidenceRoot,
    "--output-dir",
    outputDir,
  ], {
    APP_ENV: "production",
    COMMERCIAL_GO_MODE: "true",
    SIGNED_CONDITIONAL_GO_WAIVER_REF: "WAIVER-1",
    DB_PATH: "./missing-real-money-gate.db",
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, "commercial-go-validation.json"), "utf8"));
  assert.equal(report.verdict, "NO_GO");
  assert.equal(report.evidence_dir_selection, "latest");
  assert.ok(report.blockers.P0.some((row) => String(row).includes("latest evidence auto-selection")));
  assert.ok(report.blockers.P0.some((row) => String(row).includes("forbids conditional waivers")));
  assert.ok(report.blockers.P0.some((row) => String(row).includes("--release-id")));
});

test("commercial policy gate requires both public URLs and published versions", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "jpyc-policy-gate-"));
  const sourcePath = path.join(fixtureRoot, "mobile-policy.js");
  const runValidation = async (label) => {
    const outputDir = path.join(fixtureRoot, label);
    const result = await runNode("scripts/production-validation/validate-commercial-go.mjs", [
      "--policy-url-source",
      sourcePath,
      "--output-dir",
      outputDir,
    ], {
      APP_ENV: "development",
      COMMERCIAL_GO_MODE: "false",
      DB_PATH: path.join(fixtureRoot, "missing.db"),
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(fs.readFileSync(path.join(outputDir, "commercial-go-validation.json"), "utf8"));
  };

  fs.writeFileSync(sourcePath, `
const POLICY_URLS = {
  terms: "https://policies.merchant.jp/terms",
  privacy: "https://policies.merchant.jp/privacy",
  refund: "https://policies.merchant.jp/refund",
};
const POLICY_VERSIONS = {
  terms_version: "draft-v1",
  privacy_version: "2026-07-15",
  refund_policy_version: "2026-07-15",
};
`, "utf8");

  const draft = await runValidation("draft");
  assert.equal(draft.gates.policy_urls_gate, false);
  assert.deepEqual(draft.policy_urls.missing_keys, []);
  assert.deepEqual(draft.policy_urls.missing_version_keys, ["terms_version"]);

  fs.writeFileSync(sourcePath, `
const POLICY_URLS = {
  terms: "https://policies.merchant.jp/terms",
  privacy: "https://policies.merchant.jp/privacy",
  refund: "https://policies.merchant.jp/refund",
};
const POLICY_VERSIONS = {
  terms_version: "2026-07-15",
  privacy_version: "2026-07-15",
  refund_policy_version: "2026-07-15",
};
`, "utf8");

  const published = await runValidation("published");
  assert.equal(published.gates.policy_urls_gate, true);
  assert.deepEqual(published.policy_urls.missing_keys, []);
  assert.deepEqual(published.policy_urls.missing_version_keys, []);
});
