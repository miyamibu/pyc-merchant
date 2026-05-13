import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

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
