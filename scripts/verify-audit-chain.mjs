import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.resolve(process.cwd(), process.env.DB_PATH || "./data/app.db");
const db = new Database(DB_PATH, { readonly: true });

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const AUDIT_HASH_VERSION_LEGACY_V1 = "audit_hash_v1";
const AUDIT_HASH_VERSION_STORE_V2 = "audit_hash_store_v2";
const AUDIT_HASH_VERSION_EPOCH_V3 = "audit_hash_epoch_v3";
const AUDIT_HASH_VERSIONS = new Set([
  AUDIT_HASH_VERSION_LEGACY_V1,
  AUDIT_HASH_VERSION_STORE_V2,
  AUDIT_HASH_VERSION_EPOCH_V3,
]);

function parseState(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function computeEntryHash(prevHash, row, hashVersion) {
  if (!AUDIT_HASH_VERSIONS.has(hashVersion)) {
    throw new Error(`Unsupported audit hash version: ${String(hashVersion || "")}`);
  }
  let beforeState = null;
  let afterState = null;
  beforeState = parseState(row.before_state);
  afterState = parseState(row.after_state);
  const common = {
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    request_id: row.request_id || null,
    idempotency_key: row.idempotency_key || null,
    before_state: beforeState,
    after_state: afterState,
    ip_address: row.ip_address || null,
    created_at: row.created_at,
  };
  if (hashVersion === AUDIT_HASH_VERSION_LEGACY_V1) {
    return sha256(JSON.stringify({ prev_hash: prevHash || null, ...common }));
  }
  if (hashVersion === AUDIT_HASH_VERSION_STORE_V2) {
    return sha256(JSON.stringify({
      prev_hash: prevHash || null,
      store_id: row.store_id || null,
      ...common,
    }));
  }
  return sha256(JSON.stringify({
    prev_hash: prevHash || null,
    audit_epoch: row.audit_epoch || null,
    store_id: row.store_id || null,
    ...common,
  }));
}

function computeEpochAttestation(epoch) {
  return sha256(JSON.stringify({
    epoch_id: epoch.id,
    start_rowid: Number(epoch.start_rowid),
    hash_version: epoch.hash_version,
    previous_epoch_id: epoch.previous_epoch_id || null,
    previous_tail_hash: epoch.previous_tail_hash || null,
    reason: epoch.reason,
    created_at: epoch.created_at,
  }));
}

function fail(details) {
  console.error(JSON.stringify({ ok: false, ...details }, null, 2));
  process.exit(1);
}

const rows = db.prepare(`SELECT rowid, * FROM audit_logs ORDER BY rowid ASC`).all();
const hasEpochTable = Boolean(
  db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'audit_epochs'`).get()?.ok
);
if (!hasEpochTable) {
  fail({ error: "AUDIT_EPOCH_MISSING", total: rows.length });
}
const epochs = db.prepare(`SELECT * FROM audit_epochs ORDER BY start_rowid ASC`).all();
if (epochs.length === 0) {
  fail({ error: "AUDIT_EPOCH_MISSING", total: rows.length });
} else {
  for (const [index, epoch] of epochs.entries()) {
    if (
      !AUDIT_HASH_VERSIONS.has(epoch.hash_version)
      || epoch.attestation_hash !== computeEpochAttestation(epoch)
    ) {
      fail({ error: "AUDIT_EPOCH_ATTESTATION_INVALID", broken_epoch: epoch.id });
    }
    if (index === 0) {
      if (epoch.previous_epoch_id != null || epoch.previous_tail_hash != null) {
        fail({ error: "AUDIT_EPOCH_ROOT_INVALID", broken_epoch: epoch.id });
      }
      continue;
    }
    const priorRow = rows.filter((row) => Number(row.rowid) < Number(epoch.start_rowid)).at(-1);
    if (
      epoch.previous_epoch_id !== epochs[index - 1].id
      || epoch.previous_tail_hash !== (priorRow?.entry_hash || null)
    ) {
      fail({ error: "AUDIT_EPOCH_BRIDGE_INVALID", broken_epoch: epoch.id });
    }
  }
}

let prevHash = null;
let epochIndex = 0;
for (const row of rows) {
  while (
    epochIndex + 1 < epochs.length
    && Number(epochs[epochIndex + 1].start_rowid) <= Number(row.rowid)
  ) {
    epochIndex += 1;
  }
  const epoch = epochs[epochIndex];
  if (!epoch || Number(row.rowid) < Number(epoch.start_rowid)) {
    fail({ error: "AUDIT_ROW_WITHOUT_EPOCH", broken_at: row.id });
  }
  if (epoch.hash_version === AUDIT_HASH_VERSION_EPOCH_V3 && row.audit_epoch !== epoch.id) {
    fail({
      error: "AUDIT_ROW_EPOCH_MISMATCH",
      broken_at: row.id,
      expected_epoch: epoch.id,
      actual_epoch: row.audit_epoch,
    });
  }
  const expectedHash = computeEntryHash(prevHash, row, epoch.hash_version);
  if (row.prev_hash !== prevHash || row.entry_hash !== expectedHash) {
    fail({
      error: "AUDIT_HASH_CHAIN_INVALID",
      broken_at: row.id,
      broken_epoch: epoch.id,
      expected_prev_hash: prevHash,
      actual_prev_hash: row.prev_hash,
      expected_entry_hash: expectedHash,
      actual_entry_hash: row.entry_hash,
    });
  }
  prevHash = row.entry_hash;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      total: rows.length,
      tail_hash: prevHash,
      epoch_count: epochs.length,
      epochs: epochs.map((epoch) => ({
        id: epoch.id,
        start_rowid: epoch.start_rowid,
        hash_version: epoch.hash_version,
        previous_epoch_id: epoch.previous_epoch_id,
        previous_tail_hash: epoch.previous_tail_hash,
        attestation_hash: epoch.attestation_hash,
      })),
    },
    null,
    2
  )
);
