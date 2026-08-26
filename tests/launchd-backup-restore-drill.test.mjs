// Isolated backup -> restore drill for the launchd periodic backup job.
//
// This test NEVER touches repo runtime/, data/, docs/production/evidence/,
// .env.production, certificates, or any business database. Everything happens
// inside a single mkdtemp directory that this test creates and removes by
// itself:
//   <mkdtemp>/source/app.sqlite3      temporary fixture DB (not a business DB)
//   <mkdtemp>/backups/                BACKUP_DIR for scripts/deploy/backup-sqlite.sh
//
// Flow: create fixture DB with a valid audit hash chain -> run the real
// scripts/deploy/backup-sqlite.sh -> verify integrity/data of the produced
// backup -> run the real scripts/deploy/restore-drill.sh against that backup
// -> prove tamper detection fails closed -> remove its own temp directory.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Mirrors computeEntryHash(..., "audit_hash_store_v2") in
// scripts/verify-audit-chain.mjs so the fixture chain verifies end-to-end.
function entryHashStoreV2(prevHash, row) {
  return sha256(JSON.stringify({
    prev_hash: prevHash,
    store_id: row.store_id || null,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    request_id: row.request_id || null,
    idempotency_key: row.idempotency_key || null,
    before_state: row.before_state ? JSON.parse(row.before_state) : null,
    after_state: row.after_state ? JSON.parse(row.after_state) : null,
    ip_address: row.ip_address || null,
    created_at: row.created_at,
  }));
}

function epochAttestation(epoch) {
  return sha256(JSON.stringify({
    epoch_id: epoch.epoch_id,
    start_rowid: Number(epoch.start_rowid),
    hash_version: epoch.hash_version,
    previous_epoch_id: null,
    previous_tail_hash: null,
    reason: epoch.reason,
    created_at: epoch.created_at,
  }));
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:${String(process.env.PATH || "/usr/bin:/bin")}`,
    ...extra,
  };
}

function createFixtureDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = DELETE");
  db.exec(`
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      request_id TEXT,
      idempotency_key TEXT,
      store_id TEXT,
      audit_epoch TEXT,
      before_state TEXT,
      after_state TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL,
      prev_hash TEXT,
      entry_hash TEXT NOT NULL
    );
    CREATE TABLE audit_epochs (
      id TEXT PRIMARY KEY,
      start_rowid INTEGER NOT NULL,
      hash_version TEXT NOT NULL,
      previous_epoch_id TEXT,
      previous_tail_hash TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attestation_hash TEXT NOT NULL
    );
    CREATE TABLE invoices (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      amount_base_units INTEGER NOT NULL
    );
    CREATE TABLE payment_events (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      confirmations INTEGER NOT NULL
    );
    CREATE TABLE review_cases (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);

  const createdAt = new Date("2026-08-26T00:00:00.000Z").toISOString();
  const epoch = {
    epoch_id: "epoch-drill-fixture-0001",
    start_rowid: 0,
    hash_version: "audit_hash_store_v2",
    reason: "launchd_backup_restore_drill_fixture",
    created_at: createdAt,
  };
  const attestation = epochAttestation(epoch);
  assert.equal(
    attestation,
    sha256(JSON.stringify({
      epoch_id: epoch.epoch_id,
      start_rowid: 0,
      hash_version: epoch.hash_version,
      previous_epoch_id: null,
      previous_tail_hash: null,
      reason: epoch.reason,
      created_at: epoch.created_at,
    }))
  );
  db.prepare(
    `INSERT INTO audit_epochs (id, start_rowid, hash_version, previous_epoch_id, previous_tail_hash, reason, created_at, attestation_hash)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)`
  ).run(epoch.epoch_id, epoch.start_rowid, epoch.hash_version, epoch.reason, epoch.created_at, attestation);

  const baseRow = {
    actor_type: "system",
    actor_id: "drill-fixture",
    target_type: "invoice",
    target_id: "inv-drill-fixture-0001",
    request_id: null,
    idempotency_key: null,
    store_id: null,
    before_state: null,
    ip_address: null,
    created_at: createdAt,
  };
  const insert = db.prepare(
    `INSERT INTO audit_logs
       (id, actor_type, actor_id, action, target_type, target_id, request_id, idempotency_key,
        store_id, audit_epoch, before_state, after_state, ip_address, created_at, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let prevHash = null;
  const actions = ["invoice_created", "payment_detected"];
  for (const [index, action] of actions.entries()) {
    const row = {
      ...baseRow,
      action,
      after_state: JSON.stringify({ step: index + 1 }),
    };
    const entryHash = entryHashStoreV2(prevHash, row);
    insert.run(
      `audit-drill-${index + 1}`,
      row.actor_type,
      row.actor_id,
      row.action,
      row.target_type,
      row.target_id,
      row.request_id,
      row.idempotency_key,
      row.store_id,
      epoch.epoch_id,
      row.before_state,
      row.after_state,
      row.ip_address,
      row.created_at,
      prevHash,
      entryHash
    );
    prevHash = entryHash;
  }

  db.prepare(`INSERT INTO invoices (id, status, amount_base_units) VALUES (?, ?, ?)`)
    .run("inv-drill-fixture-0001", "issued", 100_000);
  db.prepare(`INSERT INTO payment_events (id, invoice_id, confirmations) VALUES (?, ?, ?)`)
    .run("pe-drill-fixture-0001", "inv-drill-fixture-0001", 2);
  db.prepare(`INSERT INTO review_cases (id, invoice_id, status) VALUES (?, ?, ?)`)
    .run("rc-drill-fixture-0001", "inv-drill-fixture-0001", "closed");
  db.close();
}

function runVerifyAuditChain(env) {
  try {
    const stdout = execFileSync(process.execPath, ["scripts/verify-audit-chain.mjs"], {
      cwd: REPO_ROOT,
      env: childEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
  }
}

test("backup then restore drill passes on an isolated mkdtemp SQLite fixture and removes its own temp dir", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jpyc-launchd-backup-drill-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const backupDir = path.join(tempRoot, "backups");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    const sourceDbPath = path.join(sourceDir, "app.sqlite3");
    createFixtureDb(sourceDbPath);

    // Sanity: the freshly built fixture chain must verify before any backup.
    const sourceVerify = runVerifyAuditChain({ DB_PATH: sourceDbPath });
    assert.equal(sourceVerify.code, 0, sourceVerify.stderr);

    // 1) Real backup script into the isolated BACKUP_DIR.
    const backupStdout = execFileSync("/bin/bash", [path.join(REPO_ROOT, "scripts", "deploy", "backup-sqlite.sh")], {
      cwd: REPO_ROOT,
      env: childEnv({ DB_PATH: sourceDbPath, BACKUP_DIR: backupDir }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const backupFile = backupStdout.trim().split("\n").filter(Boolean).at(-1);
    assert.ok(backupFile && backupFile.startsWith(backupDir), `unexpected backup path: ${backupFile}`);
    assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600, "backup file must be mode 0600");

    // 2) Integrity + data verification of the backup itself.
    const restored = new Database(backupFile, { readonly: true, fileMustExist: true });
    const quickCheck = restored.pragma("quick_check", { simple: true });
    assert.equal(quickCheck, "ok");
    assert.equal(restored.prepare(`SELECT COUNT(*) AS count FROM invoices`).get().count, 1);
    assert.equal(restored.prepare(`SELECT COUNT(*) AS count FROM payment_events`).get().count, 1);
    assert.equal(restored.prepare(`SELECT COUNT(*) AS count FROM review_cases`).get().count, 1);
    assert.equal(restored.prepare(`SELECT COUNT(*) AS count FROM audit_logs`).get().count, 2);
    const sentinelInvoice = restored.prepare(`SELECT id, status, amount_base_units FROM invoices WHERE id = ?`)
      .get("inv-drill-fixture-0001");
    assert.deepEqual(sentinelInvoice, { id: "inv-drill-fixture-0001", status: "issued", amount_base_units: 100_000 });
    restored.close();

    // 3) Audit chain still verifies from the backup copy.
    const backupVerify = runVerifyAuditChain({ DB_PATH: backupFile });
    assert.equal(backupVerify.code, 0, backupVerify.stderr);
    assert.match(backupVerify.stdout, /"ok": true/);
    assert.match(backupVerify.stdout, /"total": 2/);

    // 4) Full restore drill (its own throwaway copy is cleaned up by the script).
    const drillStdout = execFileSync("/bin/bash", [path.join(REPO_ROOT, "scripts", "deploy", "restore-drill.sh"), backupFile], {
      cwd: REPO_ROOT,
      env: childEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(drillStdout, /restore drill passed/);

    // 5) Fail-closed evidence: any tampered audit row must break verification.
    const tamperDir = path.join(tempRoot, "tamper");
    fs.mkdirSync(tamperDir, { recursive: true });
    const tamperedPath = path.join(tamperDir, "tampered.sqlite3");
    fs.copyFileSync(backupFile, tamperedPath);
    fs.chmodSync(tamperedPath, 0o600);
    const tamperDb = new Database(tamperedPath);
    tamperDb.prepare(`UPDATE audit_logs SET action = 'invoice_tampered' WHERE id = 'audit-drill-1'`).run();
    tamperDb.close();
    const tamperVerify = runVerifyAuditChain({ DB_PATH: tamperedPath });
    assert.notEqual(tamperVerify.code, 0);
    assert.match(tamperVerify.stderr, /AUDIT_HASH_CHAIN_INVALID/);
  } finally {
    // Remove only the mkdtemp directory this test created.
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
