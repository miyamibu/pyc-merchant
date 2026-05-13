import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.resolve(process.cwd(), process.env.DB_PATH || "./data/app.db");
const db = new Database(DB_PATH, { readonly: true });

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function computeEntryHash(prevHash, row) {
  let beforeState = null;
  let afterState = null;
  try {
    beforeState = row.before_state ? JSON.parse(row.before_state) : null;
  } catch {}
  try {
    afterState = row.after_state ? JSON.parse(row.after_state) : null;
  } catch {}
  return sha256(
    JSON.stringify({
      prev_hash: prevHash || null,
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
      created_at: row.created_at
    })
  );
}

const rows = db.prepare(`SELECT rowid, * FROM audit_logs ORDER BY rowid ASC`).all();
let prevHash = null;
for (const row of rows) {
  const expectedHash = computeEntryHash(prevHash, row);
  if (row.prev_hash !== prevHash || row.entry_hash !== expectedHash) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          broken_at: row.id,
          expected_prev_hash: prevHash,
          actual_prev_hash: row.prev_hash,
          expected_entry_hash: expectedHash,
          actual_entry_hash: row.entry_hash
        },
        null,
        2
      )
    );
    process.exit(1);
  }
  prevHash = row.entry_hash;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      total: rows.length,
      tail_hash: prevHash
    },
    null,
    2
  )
);
