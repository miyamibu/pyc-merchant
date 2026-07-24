import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import {
  baseServerEnv,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();
const execFileAsync = promisify(execFile);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function legacyAuditHash(row, prevHash = null) {
  return sha256(JSON.stringify({
    prev_hash: prevHash,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    request_id: row.request_id,
    idempotency_key: row.idempotency_key,
    before_state: null,
    after_state: JSON.parse(row.after_state),
    ip_address: row.ip_address,
    created_at: row.created_at,
  }));
}

test("audit epoch migration preserves legacy rows and bridges the old tail", async (t) => {
  const env = baseServerEnv();
  const legacy = new Database(env.DB_PATH);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE stores (
      id TEXT PRIMARY KEY,
      merchant_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
      admin_contact TEXT NOT NULL,
      invoice_ttl_sec INTEGER NOT NULL DEFAULT 300,
      chain_id TEXT NOT NULL DEFAULT '137',
      token_contract TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      store_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      request_id TEXT,
      idempotency_key TEXT,
      before_state TEXT,
      after_state TEXT,
      prev_hash TEXT,
      entry_hash TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL
    );
  `);
  legacy.prepare(
    `INSERT INTO stores
     (id, name, admin_contact, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("store-001", "Legacy Store", "legacy@example.invalid", "2026-07-23T00:00:00.000Z", "2026-07-23T00:00:00.000Z");
  const legacyRow = {
    id: "legacy-audit-1",
    actor_type: "system",
    actor_id: "legacy-runtime",
    action: "legacy.event",
    target_type: "system",
    target_id: "legacy-target",
    request_id: null,
    idempotency_key: null,
    before_state: null,
    after_state: JSON.stringify({ safe: true }),
    ip_address: null,
    created_at: "2026-07-23T00:00:00.000Z",
  };
  const legacyEntryHash = legacyAuditHash(legacyRow);
  const scopedLegacyRow = {
    id: "legacy-audit-scoped-1",
    store_id: "store-001",
    actor_type: "system",
    actor_id: "legacy-runtime",
    action: "legacy.scoped_event",
    target_type: "system",
    target_id: "legacy-scoped-target",
    request_id: null,
    idempotency_key: null,
    before_state: null,
    after_state: JSON.stringify({ safe: true, store_id: "store-001" }),
    ip_address: null,
    created_at: "2026-07-23T00:00:01.000Z",
  };
  const scopedLegacyEntryHash = legacyAuditHash(scopedLegacyRow, legacyEntryHash);
  legacy.prepare(
    `INSERT INTO audit_logs
     (id, store_id, actor_type, actor_id, action, target_type, target_id, request_id, idempotency_key,
      before_state, after_state, prev_hash, entry_hash, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    legacyRow.id,
    null,
    legacyRow.actor_type,
    legacyRow.actor_id,
    legacyRow.action,
    legacyRow.target_type,
    legacyRow.target_id,
    legacyRow.request_id,
    legacyRow.idempotency_key,
    legacyRow.before_state,
    legacyRow.after_state,
    null,
    legacyEntryHash,
    legacyRow.ip_address,
    legacyRow.created_at,
  );
  legacy.prepare(
    `INSERT INTO audit_logs
     (id, store_id, actor_type, actor_id, action, target_type, target_id, request_id, idempotency_key,
      before_state, after_state, prev_hash, entry_hash, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    scopedLegacyRow.id,
    scopedLegacyRow.store_id,
    scopedLegacyRow.actor_type,
    scopedLegacyRow.actor_id,
    scopedLegacyRow.action,
    scopedLegacyRow.target_type,
    scopedLegacyRow.target_id,
    scopedLegacyRow.request_id,
    scopedLegacyRow.idempotency_key,
    scopedLegacyRow.before_state,
    scopedLegacyRow.after_state,
    legacyEntryHash,
    scopedLegacyEntryHash,
    scopedLegacyRow.ip_address,
    scopedLegacyRow.created_at,
  );
  legacy.close();

  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });

  const preserved = db.prepare(`SELECT rowid, * FROM audit_logs WHERE id = ?`).get(legacyRow.id);
  assert.equal(preserved.rowid, 1);
  assert.equal(preserved.store_id, null);
  assert.equal(preserved.audit_epoch, null);
  assert.equal(preserved.prev_hash, null);
  assert.equal(preserved.entry_hash, legacyEntryHash);
  assert.equal(preserved.after_state, legacyRow.after_state);

  const scopedPreserved = db.prepare(`SELECT rowid, * FROM audit_logs WHERE id = ?`).get(scopedLegacyRow.id);
  assert.equal(scopedPreserved.store_id, "store-001");
  const attribution = db.prepare(
    `SELECT store_id, attribution_method, source_entry_hash
     FROM audit_log_store_attributions WHERE audit_log_id = ?`
  ).get(scopedLegacyRow.id);
  assert.deepEqual(attribution, {
    store_id: "store-001",
    attribution_method: "embedded_legacy_store_id_v1",
    source_entry_hash: scopedLegacyEntryHash,
  });

  const epochs = db.prepare(`SELECT * FROM audit_epochs ORDER BY start_rowid ASC`).all();
  assert.equal(epochs.length, 2);
  assert.equal(epochs[0].start_rowid, 1);
  assert.equal(epochs[0].hash_version, "audit_hash_v1");
  assert.equal(epochs[1].start_rowid, 3);
  assert.equal(epochs[1].hash_version, "audit_hash_epoch_v3");
  assert.equal(epochs[1].previous_epoch_id, epochs[0].id);
  assert.equal(epochs[1].previous_tail_hash, scopedLegacyEntryHash);

  const newRows = db.prepare(`SELECT rowid, audit_epoch, prev_hash FROM audit_logs WHERE rowid >= 3 ORDER BY rowid ASC`).all();
  assert.ok(newRows.length > 0);
  assert.ok(newRows.every((row) => row.audit_epoch === epochs[1].id));
  assert.equal(newRows[0].prev_hash, scopedLegacyEntryHash);

  db.prepare(`UPDATE audit_logs SET store_id = ? WHERE id = ?`).run("store-attacker", scopedLegacyRow.id);
  const scopedView = db.prepare(`SELECT store_id, store_id_source FROM audit_logs_scoped WHERE id = ?`).get(scopedLegacyRow.id);
  assert.deepEqual(scopedView, { store_id: "store-001", store_id_source: "attested" });

  assert.throws(
    () => db.prepare(`UPDATE audit_epochs SET reason = reason WHERE id = ?`).run(epochs[0].id),
    /audit epochs are immutable/
  );

  const verification = await execFileAsync(process.execPath, ["scripts/verify-audit-chain.mjs"], {
    cwd: CWD,
    env: { ...process.env, DB_PATH: env.DB_PATH },
  });
  const report = JSON.parse(verification.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.epoch_count, 2);
  assert.equal(report.tail_hash, db.prepare(`SELECT entry_hash FROM audit_logs ORDER BY rowid DESC LIMIT 1`).get().entry_hash);
});
