#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
EVIDENCE_ROOT="${PRODUCTION_EVIDENCE_ROOT:-./docs/production/evidence}"
EVIDENCE_ROOT="${EVIDENCE_ROOT%/}"
EVIDENCE_DIR="${PRODUCTION_EVIDENCE_DIR:-${EVIDENCE_ROOT}/${TIMESTAMP}}"
mkdir -p "$EVIDENCE_DIR"

export DB_PATH="${DB_PATH:-$EVIDENCE_DIR/validation-app.db}"
export WORKER_STATE_DB_PATH="${WORKER_STATE_DB_PATH:-$EVIDENCE_DIR/validation-worker-state.db}"
export BACKUP_DIR="${BACKUP_DIR:-$EVIDENCE_DIR/backups}"
export COMMERCIAL_EVIDENCE_ROOT="${COMMERCIAL_EVIDENCE_ROOT:-$EVIDENCE_ROOT}"

PRODUCTION_LIKE_VALIDATION=false
if [[ "${APP_ENV:-development}" == "production" \
  || "${DEPLOYMENT_STAGE:-}" == "pilot" \
  || "${DEPLOYMENT_STAGE:-}" == "commercial" \
  || "${COMMERCIAL_GO_MODE:-}" =~ ^(1|true|yes|on)$ ]]; then
  PRODUCTION_LIKE_VALIDATION=true
fi

# Development validation runs several server processes against the same isolated
# DB. Keep the generated fallback receipt key stable across those processes,
# while production-like validation still requires explicit key configuration.
if [[ "$PRODUCTION_LIKE_VALIDATION" == "false" \
  && -z "${APP_SECRET:-}" \
  && -z "${PAYMENT_RECEIPT_KEY_RING:-}" ]]; then
  export APP_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))')"
  export PAYMENT_RECEIPT_KEY_RING="app-secret-v1=${APP_SECRET}"
fi

if [[ -z "${BASE_URL:-}" ]]; then
  case "${APP_HOST:-}" in
    http://127.0.0.1:*|http://localhost:*)
      export BASE_URL="$APP_HOST"
      ;;
    "")
      export BASE_URL="http://127.0.0.1:${APP_PORT:-4173}"
      ;;
    *)
      echo "BASE_URL must be explicit when APP_HOST is not a local validation host" >&2
      exit 1
      ;;
  esac
fi
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

bash ./scripts/production-validation/collect-evidence.sh "$EVIDENCE_DIR" >/dev/null

run_step check npm run check
# Keep validation-only production configuration from changing tests that
# intentionally assert unsafe/default startup behavior.  Run the fixture
# suite serially so concurrent test servers cannot collide on ephemeral ports
# and make the production validation result nondeterministic.
run_step test env -i PATH="$PATH" npm run test:serial
run_step audit npm run audit
run_step smoke npm run test:smoke
run_step audit-chain npm run test:audit-chain
run_step deploy-check npm run deploy:check
VALIDATE_PRODUCTION_CONFIG_ARGS=(--app-env "${APP_ENV:-development}")
if [[ -z "${RPC_URLS:-}" ]]; then
  VALIDATE_PRODUCTION_CONFIG_ARGS+=(--skip-rpc)
fi
run_json_step validate-production-config node scripts/production-validation/validate-production-config.mjs "${VALIDATE_PRODUCTION_CONFIG_ARGS[@]}"
run_json_step validate-dependency-docker-hygiene node scripts/production-validation/validate-dependency-docker-hygiene.mjs --output "$EVIDENCE_DIR/license-list.json"
run_json_step validate-public-invoice-api node scripts/production-validation/validate-public-invoice-api.mjs
run_json_step validate-wallet-launch node scripts/production-validation/validate-wallet-launch.mjs
run_json_step validate-smoke-payment-flow node scripts/production-validation/validate-smoke-payment-flow.mjs
run_step backup-sqlite bash ./scripts/deploy/backup-sqlite.sh
run_step restore-drill bash ./scripts/deploy/restore-drill.sh
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
