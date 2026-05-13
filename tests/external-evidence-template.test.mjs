import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = process.cwd();

test("external evidence template generator creates EXT-001 through EXT-004 files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-ext-evidence-"));
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
    "EXT-002-hashport-device-launch.md",
    "EXT-003-public-fqdn-tls.md",
    "EXT-004-store-ops-drill.md",
  ]) {
    const fullPath = path.join(dir, fileName);
    assert.equal(fs.existsSync(fullPath), true, fileName);
    const content = fs.readFileSync(fullPath, "utf8");
    assert.match(content, /status:\s*pending/i);
    assert.match(content, /(checked_at|実施日時):/i);
    if (fileName === "EXT-001-real-jpyc-payment.md") {
      assert.match(content, /(tx_hash|actual_tx_hash):/i);
    }
  }
});
