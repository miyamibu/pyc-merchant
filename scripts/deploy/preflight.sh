#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env.production}"
ALLOW_EMPTY="${2:-}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "preflight failed: env file not found: $ENV_FILE" >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "${line//[[:space:]]/}" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" != *=* ]]; then
    continue
  fi
  key="${line%%=*}"
  value="${line#*=}"
  key="${key//[[:space:]]/}"
  export "$key=$value"
done < "$ENV_FILE"

required_keys=(
  APP_IMAGE_REF
  NGINX_IMAGE_REF
  APP_ENV
  APP_PORT
  APP_HOST
  DB_PATH
  WORKER_STATE_DB_PATH
  APP_SECRET
  SERVICE_INGEST_SECRET
  METRICS_SECRET
  CHAIN_ID
  TOKEN_CONTRACT
  TOKEN_SYMBOL
  RECIPIENT_ADDRESS
  TOKEN_DECIMALS
  LEDGER_DECIMALS
  LEDGER_BASE_UNIT_SCALE
  APPROVED_JPYC_TOKEN_CONTRACT
  JPYC_CONTRACT_APPROVAL_REF
  REQUIRED_CONFIRMATIONS
  MIN_REQUIRED_CONFIRMATIONS
  CONFIRMATIONS_POLICY_APPROVAL_REF
  MONITOR_BACKSCAN_BLOCKS
  MIN_MONITOR_BACKSCAN_BLOCKS
  BACKSCAN_POLICY_APPROVAL_REF
  WALLET_ADAPTER_TYPE
  ENABLE_REOWN
  REOWN_PROJECT_ID
  CHECKOUT_SESSION_IMPLEMENTED
  LEGAL_GATE_APPROVED
  LEGAL_GATE_APPROVAL_REF
  AML_POLICY_APPROVED
  AML_POLICY_APPROVAL_REF
  PRIVACY_POLICY_APPROVED
  PRIVACY_POLICY_APPROVAL_REF
  APPI_POLICY_APPROVED
  APPI_POLICY_APPROVAL_REF
  APPI_RETENTION_POLICY_REF
  APPI_DELETION_PROCEDURE_REF
  APPI_DISCLOSURE_PROCEDURE_REF
  RPC_URLS
)

missing=()
for key in "${required_keys[@]}"; do
  if [[ -z "${!key:-}" && "$ALLOW_EMPTY" != "--allow-empty" ]]; then
    missing+=("$key")
  fi
done

for key in APP_IMAGE_REF NGINX_IMAGE_REF; do
  value="${!key:-}"
  if [[ -n "$value" && ! "$value" =~ @sha256:[0-9a-fA-F]{64}$ ]]; then
    echo "preflight failed: $key must be a registry reference pinned by sha256 digest" >&2
    exit 1
  fi
done

if [[ "${#missing[@]}" -gt 0 ]]; then
  printf 'preflight failed: missing required values: %s\n' "${missing[*]}" >&2
  exit 1
fi

if [[ "$ALLOW_EMPTY" != "--allow-empty" ]]; then
  financial_db_resolved="$(cd "$(dirname "$DB_PATH")" && pwd)/$(basename "$DB_PATH")"
  worker_state_db_resolved="$(cd "$(dirname "$WORKER_STATE_DB_PATH")" && pwd)/$(basename "$WORKER_STATE_DB_PATH")"
  if [[ "$financial_db_resolved" == "$worker_state_db_resolved" ]]; then
    echo "preflight failed: WORKER_STATE_DB_PATH must differ from DB_PATH" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$DB_PATH")" "$(dirname "$WORKER_STATE_DB_PATH")" "${BACKUP_DIR:-./runtime/backups}" ./runtime/logs
fi
node --check src/server.mjs >/dev/null
node --check src/chain-monitor.mjs >/dev/null

echo "preflight ok: $ENV_FILE"
