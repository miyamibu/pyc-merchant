#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_DIR="${1:-./docs/production/evidence/$(date -u +"%Y%m%dT%H%M%SZ")/deploy-logs}"
mkdir -p "$OUTPUT_DIR"

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git rev-parse HEAD > "$OUTPUT_DIR/git-commit.txt"
else
  printf 'UNKNOWN\n' > "$OUTPUT_DIR/git-commit.txt"
fi
node -p "process.version" > "$OUTPUT_DIR/node-version.txt"
node -p "require('./package.json').version" > "$OUTPUT_DIR/app-version.txt"
uname -a > "$OUTPUT_DIR/uname.txt"
env | cut -d= -f1 | sort > "$OUTPUT_DIR/env-keys.txt"

if command -v docker >/dev/null 2>&1; then
  docker compose -f docker-compose.prod.yml ps > "$OUTPUT_DIR/docker-compose-ps.txt" 2>&1 || true
  docker compose -f docker-compose.prod.yml logs --no-color > "$OUTPUT_DIR/docker-compose-logs.txt" 2>&1 || true
fi

if command -v journalctl >/dev/null 2>&1; then
  journalctl -u jpyc-payment-terminal.service -n 500 --no-pager > "$OUTPUT_DIR/journalctl.txt" 2>&1 || true
fi

bash ./scripts/deploy/healthcheck.sh > "$OUTPUT_DIR/healthcheck.txt" 2>&1 || true

echo "$OUTPUT_DIR"
