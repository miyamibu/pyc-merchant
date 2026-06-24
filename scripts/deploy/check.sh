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

if command -v docker >/dev/null 2>&1; then
  if [[ -f .env.production ]]; then
    docker compose -f docker-compose.prod.yml config >/dev/null
  else
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/jpyc-compose-check.XXXXXX")"
    cleanup() {
      if [[ -n "${tmp_dir:-}" && "$tmp_dir" == "${TMPDIR:-/tmp}"/jpyc-compose-check.* && -d "$tmp_dir" ]]; then
        rm -r -- "$tmp_dir"
      fi
    }
    trap cleanup EXIT
    cp docker-compose.prod.yml "$tmp_dir/docker-compose.prod.yml"
    cp .env.production.example "$tmp_dir/.env.production"
    mkdir -p "$tmp_dir/deploy/nginx/certs"
    if [[ -f deploy/nginx/jpyc-payment-terminal.conf ]]; then
      cp deploy/nginx/jpyc-payment-terminal.conf "$tmp_dir/deploy/nginx/jpyc-payment-terminal.conf"
    fi
    (
      cd "$tmp_dir"
      docker compose -f docker-compose.prod.yml config >/dev/null
    )
  fi
fi

echo "deploy check ok"
