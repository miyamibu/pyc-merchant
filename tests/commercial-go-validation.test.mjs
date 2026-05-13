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
