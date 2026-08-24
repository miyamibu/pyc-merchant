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

test("commercial validation reports dangerous production flags as P0 blockers", async () => {
  const evidenceRoot = mkdtempSync(path.join(tmpdir(), "jpyc-danger-evidence-"));
  const latestDir = path.join(evidenceRoot, "20260422T010101Z");
  fs.mkdirSync(latestDir, { recursive: true });
  fs.writeFileSync(path.join(latestDir, "EXT-001-real-jpyc-payment.md"), "- status: pass\n- actual_tx_hash: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n- invoice_id: inv-1\n- amount: 1\n- expected_amount_atomic: 1000000\n- block_number: 1\n- block_timestamp: 2026-04-22T00:00:00Z\n- detected_at: 2026-04-22T00:00:01Z\n- status_transition: confirming->paid\n- tester: qa\n", "utf8");
  fs.writeFileSync(path.join(latestDir, "EXT-002-wallet-device-launch.md"), "- status: pass\n- hashport_wallet_ios_status: pass\n- hashport_wallet_android_status: pass\n- copy_fallback_status: pass\n- screenshot_ref: shot\n- tester: qa\n- checked_at: 2026-04-22T00:00:00Z\n", "utf8");
  fs.writeFileSync(path.join(latestDir, "EXT-003-public-fqdn-tls.md"), "- status: pass\n- domain: terminal.example.jp\n- tls_issuer: Let's Encrypt\n- tls_expiry: 2026-05-01\n- healthz_result: pass\n- readyz_result: pass\n- pay_ref_result: pass\n- https_redirect_result: pass\n", "utf8");
  fs.writeFileSync(path.join(latestDir, "EXT-004-store-ops-drill.md"), "- status: pass\n- participant: staff-a\n- scenario: close\n- invoice_issue_time: 1\n- qr_display_time: 1\n- review_handling: pass\n- refund_evidence_handling: pass\n- daily_close: pass\n- incident_escalation: pass\n- self_resolution_result: pass\n- operator_signature: signed\n", "utf8");

  const outputDir = mkdtempSync(path.join(tmpdir(), "jpyc-danger-output-"));
  const result = await runNode("scripts/production-validation/validate-commercial-go.mjs", [
    "--evidence-root",
    evidenceRoot,
    "--output-dir",
    outputDir,
  ], {
    APP_ENV: "production",
    COMMERCIAL_GO_MODE: "true",
    CHAIN_ID: "137",
    TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
    APPROVED_JPYC_TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
    TOKEN_DECIMALS: "18",
    JPYC_BASE_UNIT_SCALE: "1000000",
    LEGAL_GATE_APPROVED: "true",
    LEGAL_GATE_APPROVAL_REF: "LEGAL-1",
    AML_POLICY_APPROVED: "true",
    AML_POLICY_APPROVAL_REF: "AML-1",
    PRIVACY_POLICY_APPROVED: "true",
    PRIVACY_POLICY_APPROVAL_REF: "PRIV-1",
    APPI_POLICY_APPROVED: "true",
    APPI_POLICY_APPROVAL_REF: "APPI-1",
    JPYC_CONTRACT_APPROVAL_REF: "JPYC-1",
    CONFIRMATIONS_POLICY_APPROVAL_REF: "CONF-1",
    BACKSCAN_POLICY_APPROVAL_REF: "BACK-1",
    REQUIRED_CONFIRMATIONS: "2",
    MIN_REQUIRED_CONFIRMATIONS: "2",
    MONITOR_BACKSCAN_BLOCKS: "12",
    MIN_MONITOR_BACKSCAN_BLOCKS: "12",
    REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR: "true",
    SETTLEMENT_UNRESOLVED_REVIEW_POLICY: "block",
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: "wallet://pay?uri={{payment_uri_encoded}}",
    APP_SECRET: "A".repeat(48),
    SERVICE_INGEST_SECRET: "B".repeat(48),
    METRICS_SECRET: "C".repeat(48),
    CORS_ALLOW_ORIGINS: "https://terminal.example.jp",
    TRUST_PROXY: "true",
    ENABLE_PUBLIC_PAYMENT_SIMULATION: "true",
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, "commercial-go-validation.json"), "utf8"));
  assert.equal(report.verdict, "NO_GO");
  assert.ok(report.blockers.P0.some((row) => String(row).includes("ENABLE_PUBLIC_PAYMENT_SIMULATION")));
  assert.equal(report.gates.policy_urls_gate, false);
  assert.ok(report.blockers.P1.some((row) => String(row).includes("policy URLs")));
});
