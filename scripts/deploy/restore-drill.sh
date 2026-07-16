#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${BACKUP_DIR:-./runtime/backups}"
BACKUP_FILE="${1:-}"

if [[ -z "$BACKUP_FILE" ]]; then
  BACKUP_FILE="$(ls -1t "$BACKUP_DIR"/app-*.sqlite3 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$BACKUP_FILE" ]]; then
  echo "restore drill failed: backup file not found" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jpyc-restore-drill-XXXXXX")"
chmod 700 "$TMP_DIR"
cleanup_restore_drill() {
  rm -f "$RESTORE_PATH" 2>/dev/null || true
  rmdir "$TMP_DIR" 2>/dev/null || true
}
trap cleanup_restore_drill EXIT
RESTORE_PATH="$TMP_DIR/restored-app.db"
cp "$BACKUP_FILE" "$RESTORE_PATH"
chmod 600 "$RESTORE_PATH"

node - "$RESTORE_PATH" <<'NODE'
const Database = require("better-sqlite3");
const path = require("node:path");

const restorePath = path.resolve(process.argv[2]);
const db = new Database(restorePath, { readonly: true });
const quickCheck = db.pragma("quick_check", { simple: true });
if (quickCheck !== "ok") {
  console.error(`sqlite quick_check failed: ${quickCheck}`);
  process.exit(1);
}
const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get();
db.close();
if (!tables || Number(tables.count || 0) < 5) {
  console.error("sqlite restore drill failed: expected tables missing");
  process.exit(1);
}
NODE

DB_PATH="$RESTORE_PATH" node scripts/verify-audit-chain.mjs

echo "restore drill passed; temporary decrypted database was removed"
