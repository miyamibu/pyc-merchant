#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env.production}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "production env validation failed: env file not found: $ENV_FILE" >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "${line//[[:space:]]/}" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" != *=* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  key="${key//[[:space:]]/}"
  export "$key=$value"
done < "$ENV_FILE"

node ./scripts/production-validation/validate-production-config.mjs --env-file "$ENV_FILE"
