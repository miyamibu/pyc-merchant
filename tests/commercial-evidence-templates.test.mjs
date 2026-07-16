import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateCommercialEvidence } from "../scripts/production-validation/validate-commercial-evidence.mjs";

const ROOT = process.cwd();

test("commercial external evidence template preparation creates EXT and POC files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-commercial-template-"));
  await new Promise((resolve, reject) => {
    execFile(
      "bash",
      ["scripts/production-validation/prepare-external-validation-evidence.sh", dir],
      { cwd: ROOT },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });

  for (const fileName of [
    "EXT-001-real-jpyc-payment.md",
    "EXT-002-wallet-device-launch.md",
    "EXT-003-public-fqdn-tls.md",
    "EXT-004-store-ops-drill.md",
    "POC-001.md",
    "POC-002.md",
    "POC-003.md",
  ]) {
    const fullPath = path.join(dir, fileName);
    assert.equal(fs.existsSync(fullPath), true, fileName);
    const content = fs.readFileSync(fullPath, "utf8");
    assert.match(content, /status:\s*pending/i);
  }

  const ext002 = fs.readFileSync(path.join(dir, "EXT-002-wallet-device-launch.md"), "utf8");
  assert.match(ext002, /hashport_wallet_ios_status:/i);
  assert.match(ext002, /hashport_wallet_android_status:/i);
});

test("EXT-003 requires live TLS and endpoint pass evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "jpyc-ext003-validation-"));
  const evidenceDir = path.join(root, "20260715T000000Z");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "EXT-003-public-fqdn-tls.md"),
    [
      "- status: pass",
      "- domain: pay.merchant.jp",
      "- tls_issuer: Let's Encrypt",
      "- tls_expiry: 2099-01-01T00:00:00Z",
      "- tls_san: pay.merchant.jp, *.merchant.jp",
      "- healthz_result: pass",
      "- readyz_result: pass",
      "- pay_ref_result: pass",
      "- https_redirect_result: pass",
      "- screenshot_ref: evidence://ext003",
      "- tester: qa",
      "- checked_at: 2026-07-15T00:00:00Z",
    ].join("\n"),
    "utf8"
  );
  const valid = validateCommercialEvidence({ evidenceRoot: root, evidenceDir });
  assert.equal(valid.ext.EXT_003.ok, true);

  fs.writeFileSync(
    path.join(evidenceDir, "EXT-003-public-fqdn-tls.md"),
    [
      "- status: pass",
      "- domain: pay.merchant.jp",
      "- tls_issuer: Let's Encrypt",
      "- tls_expiry: 2020-01-01T00:00:00Z",
      "- tls_san: other.merchant.jp",
      "- healthz_result: fail_dns_unresolved",
      "- readyz_result: pass",
      "- pay_ref_result: pass",
      "- https_redirect_result: pass",
      "- screenshot_ref: evidence://ext003",
      "- tester: qa",
      "- checked_at: 2026-07-15T00:00:00Z",
    ].join("\n"),
    "utf8"
  );
  const invalid = validateCommercialEvidence({ evidenceRoot: root, evidenceDir });
  assert.equal(invalid.ext.EXT_003.ok, false);
  assert.ok(invalid.ext.EXT_003.errors.includes("expired_tls_certificate"));
  assert.ok(invalid.ext.EXT_003.errors.includes("tls_san_mismatch"));
  assert.ok(invalid.ext.EXT_003.errors.includes("healthz_fail_dns_unresolved"));
});
