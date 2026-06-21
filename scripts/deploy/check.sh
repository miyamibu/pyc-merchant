#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

bash -n scripts/deploy/*.sh
bash -n scripts/production-validation/*.sh
node --check scripts/production-validation/lib.mjs >/dev/null
node --check scripts/production-validation/validate-production-config.mjs >/dev/null
node --check scripts/production-validation/validate-evidence-sanitization.mjs >/dev/null
node --check scripts/production-validation/validate-dependency-docker-hygiene.mjs >/dev/null
node --check scripts/production-validation/validate-public-invoice-api.mjs >/dev/null
node --check scripts/production-validation/validate-wallet-launch.mjs >/dev/null
node --check scripts/production-validation/validate-smoke-payment-flow.mjs >/dev/null
bash ./scripts/deploy/preflight.sh .env.production.example --allow-empty
node ./scripts/production-validation/validate-production-config.mjs --env-file .env.production.example --allow-empty --skip-rpc >/dev/null
node ./scripts/production-validation/validate-dependency-docker-hygiene.mjs --skip-docker true >/dev/null

if command -v docker >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_STATUS=0
  COMPOSE_CMD=()
  while IFS= read -r part; do
    COMPOSE_CMD+=("$part")
  done < <(node scripts/deploy/resolve-compose.mjs --print-lines) || COMPOSE_STATUS=$?
  if [ "$COMPOSE_STATUS" -ne 0 ] || [ "${#COMPOSE_CMD[@]}" -eq 0 ]; then
    node scripts/deploy/resolve-compose.mjs --json >&2 || true
    echo "DOCKER_COMPOSE_UNAVAILABLE: install or enable the official Docker Compose plugin or docker-compose." >&2
    exit 2
  fi
  if [ -f .env.production ]; then
    "${COMPOSE_CMD[@]}" --env-file .env.production -f docker-compose.prod.yml config >/dev/null
  else
    "${COMPOSE_CMD[@]}" --env-file .env.production.example -f docker-compose.prod.yml config --no-env-resolution >/dev/null
  fi
fi

echo "deploy check ok"
