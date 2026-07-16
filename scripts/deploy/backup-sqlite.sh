#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-./runtime/data/app.db}"
BACKUP_DIR="${BACKUP_DIR:-./runtime/backups}"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
TARGET_PATH="${BACKUP_DIR}/app-${TIMESTAMP}.sqlite3"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

node - "$DB_PATH" "$TARGET_PATH" <<'NODE'
const Database = require("better-sqlite3");
const path = require("node:path");

const sourcePath = path.resolve(process.argv[2]);
const targetPath = path.resolve(process.argv[3]);
const db = new Database(sourcePath, { fileMustExist: true });

(async () => {
  await db.backup(targetPath);
  db.close();
  require("node:fs").chmodSync(targetPath, 0o600);
  process.stdout.write(`${targetPath}\n`);
})().catch((error) => {
  try {
    db.close();
  } catch (_closeError) {
    // no-op
  }
  console.error(String(error.message || error));
  process.exit(1);
});
NODE
