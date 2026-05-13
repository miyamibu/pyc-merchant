import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { discoverScanFiles, scanWorkspace } from "../../scripts/security/check-destructive-ops.mjs";

function tempWorkspace() {
  return mkdtempSync(path.join(tmpdir(), "jpyc-destructive-ops-"));
}

function writeFile(rootDir, relativePath, content) {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function joinParts(...parts) {
  return parts.join(" ");
}

test("dangerous business deletes are detected", () => {
  const rootDir = tempWorkspace();
  writeFile(rootDir, "src/bad-delete.mjs", `db.prepare(\`${joinParts("DELETE", "FROM", "invoices")} WHERE id = ?\`).run(id);\n`);

  const result = scanWorkspace(rootDir);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "sql.delete.protected-table");
  assert.match(result.findings[0].message, /invoices/);
});

test("protected path recursive delete is detected", () => {
  const rootDir = tempWorkspace();
  const recursiveDeleteParts = ["rm", "-rf"];
  const protectedTarget = "runtime";
  const destructiveCommand = joinParts(...recursiveDeleteParts, protectedTarget);
  writeFile(rootDir, "scripts/wipe.sh", `${destructiveCommand}\n`);

  const result = scanWorkspace(rootDir);
  assert.ok(result.findings.some((finding) => finding.ruleId === "shell.rm-rf"));
  assert.ok(result.findings.some((finding) => finding.ruleId === "shell.protected-path-delete"));
});

test("destructive SQL schema drops are detected", () => {
  const rootDir = tempWorkspace();
  writeFile(rootDir, "migrations/001-danger.sql", `${joinParts("DROP", "TABLE", "audit_logs")};\n`);

  const result = scanWorkspace(rootDir);
  assert.ok(result.findings.some((finding) => finding.ruleId === "sql.drop-table"));
});

test("allowed non-business cleanup with explicit guards is allowed", () => {
  const rootDir = tempWorkspace();
  writeFile(
    rootDir,
    "src/cleanup.mjs",
    [
      "db.prepare(`DELETE FROM rate_limit_events WHERE created_at_unix_ms <= ?`).run(limit);",
      "db.prepare(`DELETE FROM idempotency_records WHERE expires_at <= ?`).run(now);",
      "db.prepare(`DELETE FROM service_replay_guards WHERE expires_at <= ?`).run(now);",
      "",
    ].join("\n")
  );

  const result = scanWorkspace(rootDir);
  assert.deepEqual(result.findings, []);
});

test("checker ignores generated evidence and runtime DB artifacts", () => {
  const rootDir = tempWorkspace();
  writeFile(rootDir, "tests/safe.test.mjs", "export const ok = true;\n");
  writeFile(rootDir, "docs/production/evidence/ignored-danger.sql", `${joinParts("DROP", "TABLE", "audit_logs")};\n`);
  writeFile(rootDir, "runtime/danger.sh", `${joinParts("git", "clean", "-fd")}\n`);
  writeFile(rootDir, "runtime/data/app.db", "not-a-real-db");

  const scannedFiles = discoverScanFiles(rootDir);
  assert.ok(scannedFiles.every((filePath) => !filePath.includes(`${path.sep}docs${path.sep}production${path.sep}evidence${path.sep}`)));
  assert.ok(scannedFiles.every((filePath) => !filePath.includes(`${path.sep}runtime${path.sep}`)));

  const result = scanWorkspace(rootDir);
  assert.deepEqual(result.findings, []);
});
