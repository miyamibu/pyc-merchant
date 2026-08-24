#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

EVIDENCE_DIR="${1:-./docs/production/evidence/$(date -u +"%Y%m%dT%H%M%SZ")}"
mkdir -p "$EVIDENCE_DIR"

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git rev-parse HEAD > "$EVIDENCE_DIR/git-commit.txt"
else
  printf 'UNKNOWN\n' > "$EVIDENCE_DIR/git-commit.txt"
fi
node -p "process.version" > "$EVIDENCE_DIR/node-version.txt"
npm --version > "$EVIDENCE_DIR/npm-version.txt"
uname -a > "$EVIDENCE_DIR/os.txt"
env | cut -d= -f1 | sort > "$EVIDENCE_DIR/env-keys.txt"

if [[ -f docs/production/BLOCKED_EXTERNAL_VALIDATION.md ]]; then
  cp docs/production/BLOCKED_EXTERNAL_VALIDATION.md "$EVIDENCE_DIR/BLOCKED_EXTERNAL_VALIDATION.snapshot.md"
fi

if bash ./scripts/deploy/collect-logs.sh "$EVIDENCE_DIR/deploy-logs" >/dev/null 2>&1; then
  :
else
  collect_exit=$?
  printf 'collect-logs: failed (exit %s); see %s\n' "$collect_exit" "$EVIDENCE_DIR/deploy-logs/collection-failures.txt" \
    > "$EVIDENCE_DIR/deploy-logs-collection-failure.txt"
  cat "$EVIDENCE_DIR/deploy-logs-collection-failure.txt" >&2
fi

if [[ -s "$EVIDENCE_DIR/deploy-logs/collection-failures.txt" ]]; then
  cp "$EVIDENCE_DIR/deploy-logs/collection-failures.txt" "$EVIDENCE_DIR/evidence-collection-failures.txt"
  echo "collect-evidence: evidence collected with recorded failures:" >&2
  cat "$EVIDENCE_DIR/evidence-collection-failures.txt" >&2
fi

echo "$EVIDENCE_DIR"
[[ ! -s "$EVIDENCE_DIR/evidence-collection-failures.txt" ]]
