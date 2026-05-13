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

bash ./scripts/deploy/collect-logs.sh "$EVIDENCE_DIR/deploy-logs" >/dev/null 2>&1 || true

echo "$EVIDENCE_DIR"
