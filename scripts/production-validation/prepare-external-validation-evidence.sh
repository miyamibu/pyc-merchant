#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
EVIDENCE_DIR="${1:-./docs/production/evidence/${TIMESTAMP}}"
TEMPLATE_DIR="./docs/production-evidence-templates"
mkdir -p "$EVIDENCE_DIR"

copy_template() {
  local source_file="$1"
  local target_file="$2"
  if [[ ! -f "$TEMPLATE_DIR/$source_file" ]]; then
    echo "template missing: $TEMPLATE_DIR/$source_file" >&2
    exit 1
  fi
  cp "$TEMPLATE_DIR/$source_file" "$EVIDENCE_DIR/$target_file"
}

copy_template "EXT-001-real-jpyc-payment.md" "EXT-001-real-jpyc-payment.md"
copy_template "EXT-002-wallet-device-launch.md" "EXT-002-wallet-device-launch.md"
copy_template "EXT-003-public-fqdn-tls.md" "EXT-003-public-fqdn-tls.md"
copy_template "EXT-004-store-ops-drill.md" "EXT-004-store-ops-drill.md"

# Backward-compatible alias for old test/docs references.
cp "$EVIDENCE_DIR/EXT-002-wallet-device-launch.md" "$EVIDENCE_DIR/EXT-002-hashport-device-launch.md"

copy_template "POC-001-template.md" "POC-001.md"
copy_template "POC-002-template.md" "POC-002.md"
copy_template "POC-003-template.md" "POC-003.md"

printf '%s\n' "$EVIDENCE_DIR"
