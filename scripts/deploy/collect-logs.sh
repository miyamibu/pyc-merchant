#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_DIR="${1:-./docs/production/evidence/$(date -u +"%Y%m%dT%H%M%SZ")/deploy-logs}"
mkdir -p "$OUTPUT_DIR"

FAILURES_FILE="$OUTPUT_DIR/collection-failures.txt"
: > "$FAILURES_FILE"

record_failure() {
  printf '%s\n' "$1" >> "$FAILURES_FILE"
}

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git rev-parse HEAD > "$OUTPUT_DIR/git-commit.txt"
else
  printf 'UNKNOWN\n' > "$OUTPUT_DIR/git-commit.txt"
  printf 'git-commit: git repository unavailable\n' >> "$FAILURES_FILE"
fi
node -p "process.version" > "$OUTPUT_DIR/node-version.txt"
node -p "require('./package.json').version" > "$OUTPUT_DIR/app-version.txt"
uname -a > "$OUTPUT_DIR/uname.txt"
env | cut -d= -f1 | sort > "$OUTPUT_DIR/env-keys.txt"

if command -v docker >/dev/null 2>&1; then
  rc=0
  docker compose -f docker-compose.prod.yml ps > "$OUTPUT_DIR/docker-compose-ps.txt" 2>&1 || rc=$?
  if (( rc != 0 )); then printf 'docker compose ps: failed (exit %s)\n' "$rc" >> "$FAILURES_FILE"; fi
  rc=0
  docker compose -f docker-compose.prod.yml logs --no-color > "$OUTPUT_DIR/docker-compose-logs.txt" 2>&1 || rc=$?
  if (( rc != 0 )); then printf 'docker compose logs: failed (exit %s)\n' "$rc" >> "$FAILURES_FILE"; fi
else
  printf 'docker: command not available on this host\n' >> "$FAILURES_FILE"
fi

if command -v journalctl >/dev/null 2>&1; then
  rc=0
  journalctl -u jpyc-payment-terminal.service -n 500 --no-pager > "$OUTPUT_DIR/journalctl.txt" 2>&1 || rc=$?
  if (( rc != 0 )); then printf 'journalctl: failed (exit %s)\n' "$rc" >> "$FAILURES_FILE"; fi
else
  printf 'journalctl: command not available on this host\n' >> "$FAILURES_FILE"
fi

rc=0
bash ./scripts/deploy/healthcheck.sh > "$OUTPUT_DIR/healthcheck.txt" 2>&1 || rc=$?
if (( rc != 0 )); then printf 'healthcheck: failed (exit %s)\n' "$rc" >> "$FAILURES_FILE"; fi

if [[ -s "$FAILURES_FILE" ]]; then
  echo "collect-logs: completed with recorded failures:" >&2
  cat "$FAILURES_FILE" >&2
fi

echo "$OUTPUT_DIR"
[[ ! -s "$FAILURES_FILE" ]]
