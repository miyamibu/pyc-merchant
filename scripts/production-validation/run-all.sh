#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
EVIDENCE_ROOT="${PRODUCTION_EVIDENCE_ROOT:-./artifacts/production-validation-evidence}"
EVIDENCE_ROOT="${EVIDENCE_ROOT%/}"
EVIDENCE_DIR="${PRODUCTION_EVIDENCE_DIR:-${EVIDENCE_ROOT}/${TIMESTAMP}}"
mkdir -p "$EVIDENCE_DIR"

export DB_PATH="${DB_PATH:-$EVIDENCE_DIR/validation-app.db}"
export BACKUP_DIR="${BACKUP_DIR:-$EVIDENCE_DIR/backups}"
export COMMERCIAL_EVIDENCE_ROOT="${COMMERCIAL_EVIDENCE_ROOT:-$EVIDENCE_ROOT}"
mkdir -p "$BACKUP_DIR"

run_step() {
  local name="$1"
  shift
  local log_file="$EVIDENCE_DIR/${name}.log"
  echo "==> ${name}"
  "$@" >"$log_file" 2>&1
  echo "- ${name}: PASS" >> "$EVIDENCE_DIR/summary.tmp"
}

run_json_step() {
  local name="$1"
  shift
  local log_file="$EVIDENCE_DIR/${name}.json"
  echo "==> ${name}"
  "$@" >"$log_file"
  echo "- ${name}: PASS" >> "$EVIDENCE_DIR/summary.tmp"
}

run_backup_restore_steps() {
  local backup_log="$EVIDENCE_DIR/backup-sqlite.log"
  local restore_log="$EVIDENCE_DIR/restore-drill.log"
  local backup_output
  local backup_file

  echo "==> backup-sqlite"
  if ! backup_output="$(bash ./scripts/deploy/backup-sqlite.sh 2>&1)"; then
    printf "%s\n" "$backup_output" >"$backup_log"
    return 1
  fi
  printf "%s\n" "$backup_output" >"$backup_log"
  backup_file="$(printf "%s\n" "$backup_output" | tail -n 1)"
  test -n "$backup_file"
  echo "- backup-sqlite: PASS" >> "$EVIDENCE_DIR/summary.tmp"

  echo "==> restore-drill"
  bash ./scripts/deploy/restore-drill.sh "$backup_file" >"$restore_log" 2>&1
  echo "- restore-drill: PASS" >> "$EVIDENCE_DIR/summary.tmp"

  node - "$EVIDENCE_DIR" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const evidenceDir = path.resolve(process.argv[2]);
const dbPattern = /\.(?:db|sqlite|sqlite3)$/i;
const databaseFiles = [];

function walk(dirPath) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && dbPattern.test(entry.name)) {
      databaseFiles.push(fullPath);
    }
  }
}

walk(evidenceDir);

const sanitized = databaseFiles.map((filePath) => {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    file_name: path.basename(filePath),
    relative_path: path.relative(evidenceDir, filePath),
    size_bytes: stat.size,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    sanitized_action: "removed_from_evidence_artifact",
  };
});

fs.writeFileSync(
  path.join(evidenceDir, "database-artifact-manifest.json"),
  `${JSON.stringify({ generated_at: new Date().toISOString(), sanitized }, null, 2)}\n`
);

for (const filePath of databaseFiles) {
  fs.rmSync(filePath, { force: true });
}
NODE
}

bash ./scripts/production-validation/collect-evidence.sh "$EVIDENCE_DIR" >/dev/null

run_step check npm run check
run_step test npm test
run_step audit npm run audit
run_step smoke npm run test:smoke
run_step audit-chain npm run test:audit-chain
run_step deploy-check npm run deploy:check
VALIDATE_PRODUCTION_CONFIG_ARGS=(--app-env "${APP_ENV:-development}")
if [[ -z "${RPC_URLS:-}" ]]; then
  VALIDATE_PRODUCTION_CONFIG_ARGS+=(--skip-rpc)
fi
run_json_step validate-production-config node scripts/production-validation/validate-production-config.mjs "${VALIDATE_PRODUCTION_CONFIG_ARGS[@]}"
run_json_step validate-dependency-docker-hygiene node scripts/production-validation/validate-dependency-docker-hygiene.mjs --require-resolved-digests true --output "$EVIDENCE_DIR/license-list.json"
run_json_step validate-public-invoice-api node scripts/production-validation/validate-public-invoice-api.mjs
run_json_step validate-wallet-launch node scripts/production-validation/validate-wallet-launch.mjs
run_json_step validate-smoke-payment-flow node scripts/production-validation/validate-smoke-payment-flow.mjs
run_backup_restore_steps
run_json_step validate-evidence-sanitization node scripts/production-validation/validate-evidence-sanitization.mjs --evidence-dir "$EVIDENCE_DIR"

{
  echo "# Production Validation Summary"
  echo
  echo "- Timestamp (UTC): ${TIMESTAMP}"
  echo "- Evidence directory: ${EVIDENCE_DIR}"
  echo
  cat "$EVIDENCE_DIR/summary.tmp"
  echo
  echo "## External pending"
  echo "- このパックの pass は repo/deploy validation の証跡であり、実機・実送金・公開TLSの GO 証跡ではない。"
  echo "- 実JPYC少額決済、実機 HashPort / iOS / Android 確認は [BLOCKED_EXTERNAL_VALIDATION.snapshot.md](./BLOCKED_EXTERNAL_VALIDATION.snapshot.md) を参照。"
} > "$EVIDENCE_DIR/SUMMARY.md"

rm -f "$EVIDENCE_DIR/summary.tmp"
echo "$EVIDENCE_DIR"
