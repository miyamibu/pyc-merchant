import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const OFFICIAL_CONTRACT = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";

function runNode(args = []) {
  return new Promise((resolve) => {
    execFile(
      "node",
      ["scripts/production-validation/validate-device-pair-evidence.mjs", ...args],
      { cwd: ROOT },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("device-pair validator derives pilot/commercial status and validates media integrity", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-device-pair-"));
  const mediaBody = Buffer.from("device evidence");
  fs.writeFileSync(path.join(dir, "ipad.png"), mediaBody);
  fs.writeFileSync(path.join(dir, "DEVICE-PAIR-001-connected-ipad-iphone.json"), JSON.stringify({
    schema_version: "1.0.0",
    release_id: "20260619T000000Z",
    git_commit: "8ec80ba86ff0c0f5c7882824c3f4be3d04cafd6d",
    app_version: "1.0.0",
    environment: "production-like",
    origin: "https://pay.example.jp",
    enabled_chain_ids: ["137"],
    contract_address: OFFICIAL_CONTRACT,
    required_confirmations: { "137": 2 },
    devices: {
      merchant_ipad: { detected: true, paired: true, reachable: true, orientation: "landscape" },
      customer_iphone: { detected: true, paired: true, reachable: true, orientation: "portrait" }
    },
    capabilities: {
      hashport_deeplink: "pending",
      eip681_uri: "pass",
      walletconnect_transaction_session: "not_implemented",
      manual_copy_fallback: "pass"
    },
    scenarios: {
      ipad_login: "pass",
      invoice_create: "pass",
      qr_render: "pass",
      iphone_qr_scan: "pass",
      payment_page_render: "pass",
      manual_copy_fallback: "pass"
    },
    invoice: { chain_id: "137" },
    media: [{
      relative_path: "ipad.png",
      sha256: sha256(mediaBody),
      byte_size: mediaBody.length,
      mime_type: "image/png",
      captured_at: "2026-06-19T00:00:00Z",
      device_role: "merchant_ipad",
      scenario_id: "ipad_login"
    }],
    operator_attestation: { name: "operator" },
    reviewer_attestation: { name: "reviewer" }
  }, null, 2));

  const result = await runNode(["--evidence-dir", dir]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.device_pair_ok, true);
  assert.equal(parsed.ext002_pilot_ok, true);
  assert.equal(parsed.ext002_commercial_ok, false);
});
