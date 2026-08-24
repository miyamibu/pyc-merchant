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

test("unclassified SQL deletes fail closed", () => {
  const rootDir = tempWorkspace();
  writeFile(rootDir, "src/unknown-cleanup.mjs", `db.prepare(\`${joinParts("DELETE", "FROM", "unknown_cache")} WHERE id = ?\`).run(id);\n`);

  const result = scanWorkspace(rootDir);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "sql.delete.unclassified-table");
});

test("isolated dead-letter test fixture cleanup remains allowed only under tests", () => {
  const rootDir = tempWorkspace();
  const statement = `db.prepare(\`${joinParts("DELETE", "FROM", "chain_dead_letters")}\`).run();\n`;
  writeFile(rootDir, "tests/fixture-cleanup.test.mjs", statement);
  writeFile(rootDir, "src/runtime-cleanup.mjs", statement);

  const result = scanWorkspace(rootDir);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, "src/runtime-cleanup.mjs");
  assert.equal(result.findings[0].ruleId, "sql.delete.unclassified-table");
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

test("M-040 multiline DELETE statements are classified like single-line ones", () => {
  const rootDir = tempWorkspace();
  writeFile(
    rootDir,
    "src/multiline-delete.mjs",
    [
      "const sql = `",
      "  DELETE FROM",
      "    invoices",
      "  WHERE id = ?",
      "`;",
      "",
    ].join("\n")
  );

  const result = scanWorkspace(rootDir);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "sql.delete.protected-table");
  assert.equal(result.findings[0].line, 2);
});

test("M-040 multiline allowlisted deletes with guards on later lines stay allowed", () => {
  const rootDir = tempWorkspace();
  writeFile(
    rootDir,
    "src/multiline-cleanup.mjs",
    [
      "db.prepare(`",
      "  DELETE FROM rate_limit_events",
      "  WHERE created_at_unix_ms <= ?",
      "`).run(limit);",
      "",
    ].join("\n")
  );

  const result = scanWorkspace(rootDir);
  assert.deepEqual(result.findings, []);
});

test("M-040 dynamically concatenated DELETE statements fail closed", () => {
  const rootDir = tempWorkspace();
  writeFile(rootDir, "src/dynamic-sql.mjs", 'db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);\n');
  writeFile(rootDir, "scripts/dynamic-sql.sh", 'SQL="DELETE FROM "$TABLE" WHERE id = 1"\n');

  const result = scanWorkspace(rootDir);
  const concatFindings = result.findings.filter((finding) => finding.ruleId === "sql.delete.dynamic-concat");
  assert.ok(concatFindings.length >= 1);
});

test("M-040 public surfaces are scanned", () => {
  const rootDir = tempWorkspace();
  writeFile(rootDir, "public/admin-tool.js", 'const wipe = "rm -rf data"; // never run this\n');

  const result = scanWorkspace(rootDir);
  assert.ok(result.scannedFiles.some((filePath) => filePath.startsWith("public/")));
  assert.ok(result.findings.some((finding) => finding.ruleId === "shell.protected-path-delete"));
});

test("M-040 multiline DROP TABLE is detected exactly once per statement", () => {
  const rootDir = tempWorkspace();
  writeFile(
    rootDir,
    "migrations/002-danger.sql",
    [
      "DROP",
      "TABLE",
      "audit_logs;",
      "",
    ].join("\n")
  );

  const result = scanWorkspace(rootDir);
  const dropFindings = result.findings.filter((finding) => finding.ruleId === "sql.drop-table");
  assert.equal(dropFindings.length, 1);
});

test("M-040 multiline findings report accurate 1-based line numbers after leading blank lines and indentation", () => {
  const rootDir = tempWorkspace();
  writeFile(
    rootDir,
    "src/multiline-delete-line-number.mjs",
    [
      "// padding header comment",
      "",
      "  const padding = {",
      "    nested: deep.value,",
      "  };",
      "",
      "  const sql = `",
      "    DELETE FROM",
      "      audit_logs",
      "    WHERE id = ?`;",
      "",
    ].join("\n")
  );

  const result = scanWorkspace(rootDir);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "sql.delete.protected-table");
  assert.equal(result.findings[0].line, 8);
});

test("M-040 multiline DROP TABLE reports accurate line numbers across indented statements", () => {
  const rootDir = tempWorkspace();
  writeFile(
    rootDir,
    "migrations/003-danger-line-number.sql",
    [
      "-- migration header",
      "BEGIN;",
      "",
      "        DROP",
      "        TABLE",
      "        audit_logs;",
      "",
    ].join("\n")
  );

  const result = scanWorkspace(rootDir);
  const dropFindings = result.findings.filter((finding) => finding.ruleId === "sql.drop-table");
  assert.equal(dropFindings.length, 1);
  assert.equal(dropFindings[0].line, 4);
});

test("allowlisted DELETE guards must belong to the same statement", () => {
  const rootDir = tempWorkspace();
  writeFile(
    rootDir,
    "src/misleading-neighbor.mjs",
    [
      "db.prepare(`DELETE FROM rate_limit_events`).run();",
      "db.prepare(`SELECT * FROM diagnostics WHERE created_at_unix_ms <= ?`).all(limit);",
      "",
    ].join("\n")
  );

  const result = scanWorkspace(rootDir);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "sql.delete.allowlist-guard-missing");
  assert.equal(result.findings[0].line, 1);
});

test("allowlisted DELETE guards inside SQL comments do not satisfy the policy", () => {
  const rootDir = tempWorkspace();
  writeFile(
    rootDir,
    "src/comment-disguise.mjs",
    "db.prepare(`DELETE FROM idempotency_records /* WHERE expires_at <= ? */`).run();\n"
  );

  const result = scanWorkspace(rootDir);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "sql.delete.allowlist-guard-missing");
});

test("multiline findings report accurate line numbers with CRLF newlines", () => {
  const rootDir = tempWorkspace();
  writeFile(
    rootDir,
    "src/crlf-delete.mjs",
    ["// header", "", "const sql = `", "  DELETE FROM audit_logs", "  WHERE id = ?`;", ""].join("\r\n")
  );

  const result = scanWorkspace(rootDir);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "sql.delete.protected-table");
  assert.equal(result.findings[0].line, 4);
});
