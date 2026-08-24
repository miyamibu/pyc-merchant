#!/usr/bin/env bash
# M-047: canonical release-history recording for rollback identity.
#
# Usage:
#   release-history.sh record <release_id> <commit> <image_digest> <environment> [db_schema_version]
#   release-history.sh record-rollback <release_id> <commit> <image_digest> <environment> <db_schema_version> <from_release_id> <to_release_id> <status>
#   release-history.sh list [count]
#   release-history.sh current
#   release-history.sh previous
#   release-history.sh find <release_id>
#   release-history.sh validate
#
# Delegates to release-history.mjs for strict JSONL validation and proper JSON handling.
# Maintains backward-compatible CLI surface.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MJS_SCRIPT="${ROOT_DIR}/scripts/deploy/release-history.mjs"

# Ensure the mjs script exists
if [[ ! -f "$MJS_SCRIPT" ]]; then
  echo "release-history.mjs not found at $MJS_SCRIPT" >&2
  exit 1
fi

# Node binary detection
# Priority: explicit NODE_BIN (if set and executable) -> /opt/homebrew/opt/node@24/bin/node -> PATH node
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]] || [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="/opt/homebrew/opt/node@24/bin/node"
fi
if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" ]] || [[ ! -x "$NODE_BIN" ]]; then
  echo "node not found" >&2
  exit 1
fi

# Verify Node major version 24
NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || echo "")"
if [[ -z "$NODE_VERSION" ]]; then
  echo "node version detection failed" >&2
  exit 1
fi
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [[ "$NODE_MAJOR" -ne 24 ]]; then
  echo "node major version must be 24, found $NODE_MAJOR" >&2
  exit 1
fi

cmd="${1:-}"
case "$cmd" in
  record|record-rollback|list|current|previous|find|validate)
    exec "$NODE_BIN" "$MJS_SCRIPT" "$@"
    ;;
  *)
    echo "usage: $0 {record <release_id> <commit> <digest> <env> [schema_version] | record-rollback <release_id> <commit> <digest> <env> <schema_version> <from> <to> <status> | list [count] | current | previous | find <release_id> | validate}" >&2
    exit 2
    ;;
esac