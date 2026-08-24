#!/usr/bin/env bash
# M-047: guarded rollback to a canonical previous release.
#
# Usage:
#   rollback.sh [--list]
#   rollback.sh <env-file> [--to <release_id>] [--healthcheck-url <url>] [--apply]
#
# Safety rules:
# 1. Default mode is plan-only (dry-run). Real changes require explicit --apply.
# 2. Target release resolved via release-history.mjs (JSON parse + exact match).
# 3. Current release = latest status=applied event.
# 4. Duplicate/ambiguous release_id in history is rejected.
# 5. Before apply: DB backup, env file backup, schema fail-closed unless same version.
# 6. Atomic update of APP_IMAGE_REF and RELEASE_ID in env file (byte-for-byte, mode preserved).
# 7. Restart fixed systemd unit (jpyc-payment-terminal.service).
# 8. Explicit healthcheck via fixed healthcheck.sh must pass before recording applied event.
# 9. On restart/health failure: restore env, restart previous release, record failed event, exit non-zero.
# 10. Rollback event recorded with from/to/commit/digest/schema/environment/timestamp.
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HISTORY_MJS="${ROOT_DIR}/scripts/deploy/release-history.mjs"
BACKUP_SCRIPT="${ROOT_DIR}/scripts/deploy/backup-sqlite.sh"
HEALTHCHECK_SCRIPT="${ROOT_DIR}/scripts/deploy/healthcheck.sh"
SERVICE_UNIT="jpyc-payment-terminal.service"

# Transient temp path variables: initialized empty, set only by this process, cleared after mv.
# cleanup rm -f only these exact nonempty paths using --; never touches ENV_BACKUP.
TMP_ENV=""
TMP_RESTORE=""
LOCK_DIR=""
LOCK_HELD=0

cleanup() {
  if [[ -n "${TMP_ENV:-}" ]]; then
    rm -f -- "$TMP_ENV" 2>/dev/null || true
  fi
  if [[ -n "${TMP_RESTORE:-}" ]]; then
    rm -f -- "$TMP_RESTORE" 2>/dev/null || true
  fi
  if [[ -n "${LOCK_DIR:-}" && -d "$LOCK_DIR" && "${LOCK_HELD:-0}" -eq 1 ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Restore function: restores ENV_FILE exactly by cp -p from ENV_BACKUP to same-directory TMP_RESTORE and atomic mv; no awk after restoration.
# TMP_RESTORE is tracked by cleanup. On restoration failure, does not mask the failure; caller must handle nonzero exit.
restore_env() {
  local ts="$(date -u +%Y%m%dT%H%M%SZ)"
  TMP_RESTORE="${ENV_DIR}/${ENV_BASE}.rollback-restore.${ts}"
  cp -p "$ENV_BACKUP" "$TMP_RESTORE"
  chmod "$ORIG_MODE" "$TMP_RESTORE"
  mv "$TMP_RESTORE" "$ENV_FILE"
  TMP_RESTORE=""
  systemctl restart "${SERVICE_UNIT}"
}

# Node binary detection
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

# Required scripts
[[ -f "$HISTORY_MJS" ]] || { echo "release-history.mjs not found at $HISTORY_MJS" >&2; exit 1; }
[[ -f "$BACKUP_SCRIPT" ]] || { echo "backup-sqlite.sh not found at $BACKUP_SCRIPT" >&2; exit 1; }
[[ -f "$HEALTHCHECK_SCRIPT" ]] || { echo "healthcheck.sh not found at $HEALTHCHECK_SCRIPT" >&2; exit 1; }

MODE="plan"
TARGET_RELEASE=""
HEALTHCHECK_URL=""
APPLY=0
ENV_FILE=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)
      [[ "$MODE" == "plan" ]] || { echo "unexpected argument: $1" >&2; exit 2; }
      MODE="list"
      shift
      ;;
    --to)
      [[ -n "${2:-}" ]] || { echo "--to requires release_id" >&2; exit 2; }
      TARGET_RELEASE="$2"
      shift 2
      ;;
    --healthcheck-url)
      [[ -n "${2:-}" ]] || { echo "--healthcheck-url requires url" >&2; exit 2; }
      HEALTHCHECK_URL="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --service-unit)
      echo "unexpected argument: --service-unit (not supported)" >&2
      exit 2
      ;;
    -*)
      echo "unknown option: $1" >&2
      exit 2
      ;;
    *)
      if [[ -z "$ENV_FILE" ]]; then
        ENV_FILE="$1"
      else
        echo "unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ "$MODE" == "list" ]]; then
  [[ -z "$ENV_FILE" ]] || { echo "usage: rollback.sh [--list]" >&2; exit 2; }
  [[ -z "$TARGET_RELEASE" ]] || { echo "usage: rollback.sh [--list]" >&2; exit 2; }
  [[ -z "$HEALTHCHECK_URL" ]] || { echo "usage: rollback.sh [--list]" >&2; exit 2; }
  [[ $APPLY -eq 0 ]] || { echo "usage: rollback.sh [--list]" >&2; exit 2; }
  "$NODE_BIN" "$HISTORY_MJS" list 20
  exit 0
fi

# Normal mode requires env-file
[[ -n "$ENV_FILE" ]] || { echo "usage: rollback.sh <env-file> [--to <release_id>] [--healthcheck-url <url>] [--apply]" >&2; exit 2; }

# Validate env file: regular file, non-symlink
[[ -f "$ENV_FILE" ]] || { echo "env file not found: $ENV_FILE" >&2; exit 2; }
[[ ! -L "$ENV_FILE" ]] || { echo "env file must not be a symlink: $ENV_FILE" >&2; exit 2; }

# Load history and validate
"$NODE_BIN" "$HISTORY_MJS" validate >/dev/null || {
  echo "release history validation failed" >&2
  exit 3
}

# Get current release (latest status=applied)
current_json="$("$NODE_BIN" "$HISTORY_MJS" current 2>/dev/null)" || {
  echo "no applied release found in history; cannot determine current release" >&2
  exit 4
}

current_release="$(printf '%s' "$current_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); console.log(JSON.parse(d).release_id)")"
current_commit="$(printf '%s' "$current_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); console.log(JSON.parse(d).commit)")"
current_digest="$(printf '%s' "$current_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); console.log(JSON.parse(d).image_digest)")"
current_schema="$(printf '%s' "$current_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); const v=JSON.parse(d).db_schema_version; console.log(v || '')")"
current_env="$(printf '%s' "$current_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); console.log(JSON.parse(d).environment)")"

# Resolve target release
if [[ -z "$TARGET_RELEASE" ]]; then
  # Get previous applied release (no args)
  target_json="$("$NODE_BIN" "$HISTORY_MJS" previous 2>/dev/null)" || {
    echo "no previous applied release exists in history; nothing to roll back to" >&2
    exit 5
  }
else
  # Find exact match by release_id
  target_json="$("$NODE_BIN" "$HISTORY_MJS" find "$TARGET_RELEASE" 2>/dev/null)" || {
    echo "target release not found in history: ${TARGET_RELEASE}" >&2
    exit 6
  }
fi

target_release="$(printf '%s' "$target_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); console.log(JSON.parse(d).release_id)")"
target_commit="$(printf '%s' "$target_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); console.log(JSON.parse(d).commit)")"
target_digest="$(printf '%s' "$target_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); console.log(JSON.parse(d).image_digest)")"
target_schema="$(printf '%s' "$target_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); const v=JSON.parse(d).db_schema_version; console.log(v || '')")"
target_env="$(printf '%s' "$target_json" | "$NODE_BIN" -e "const fs=require('fs'); const d=fs.readFileSync(0,'utf8'); console.log(JSON.parse(d).environment)")"

# Verify target != current (by release_id)
if [[ "$target_release" == "$current_release" ]]; then
  echo "refusing to roll back to the currently running release (${current_release})" >&2
  exit 7
fi

# Schema compatibility: fail-closed if empty or mismatch (no override)
if [[ -z "$current_schema" || -z "$target_schema" ]]; then
  echo "DB schema version is empty in history (current='${current_schema}' target='${target_schema}'). Fail-closed." >&2
  exit 8
elif [[ "$target_schema" != "$current_schema" ]]; then
  echo "DB schema version mismatch: current=$current_schema target=$target_schema. Fail-closed." >&2
  exit 8
fi

# Environment mismatch: unconditional reject
if [[ "$target_env" != "$current_env" ]]; then
  echo "environment mismatch: current=$current_env target=$target_env. Fail-closed." >&2
  exit 9
fi

# Validate env file content: exactly one APP_IMAGE_REF and one RELEASE_ID matching current identity
app_image_ref_count="$(grep -c '^APP_IMAGE_REF=' "$ENV_FILE" || true)"
release_id_count="$(grep -c '^RELEASE_ID=' "$ENV_FILE" || true)"
if [[ "$app_image_ref_count" -ne 1 ]] || [[ "$release_id_count" -ne 1 ]]; then
  echo "env file must contain exactly one APP_IMAGE_REF and one RELEASE_ID" >&2
  exit 10
fi
env_image_ref="$(grep '^APP_IMAGE_REF=' "$ENV_FILE" | cut -d= -f2-)"
env_release_id="$(grep '^RELEASE_ID=' "$ENV_FILE" | cut -d= -f2-)"
if [[ "$env_image_ref" != "$current_digest" ]] || [[ "$env_release_id" != "$current_release" ]]; then
  echo "env file APP_IMAGE_REF/RELEASE_ID does not match current history identity" >&2
  exit 11
fi

# Print plan
echo "Rollback plan:"
echo "  current : ${current_release} commit=${current_commit} digest=${current_digest} schema=${current_schema} env=${current_env}"
echo "  target  : ${target_release} commit=${target_commit} digest=${target_digest} schema=${target_schema} env=${target_env}"
echo "  mode    : $([[ $APPLY -eq 1 ]] && echo "APPLY" || echo "PLAN (dry-run)")"

if [[ $APPLY -eq 0 ]]; then
  echo "[plan] backup-sqlite.sh"
  echo "[plan] env backup: cp -p ${ENV_FILE} ${ENV_FILE}.rollback-backup.<timestamp>"
  echo "[plan] atomic update ${ENV_FILE}: APP_IMAGE_REF=${target_digest} RELEASE_ID=${target_release}"
  echo "[plan] systemctl restart ${SERVICE_UNIT}"
  echo "[plan] healthcheck (${HEALTHCHECK_URL:-<from env or default>}) via healthcheck.sh x30"
  echo "[plan] release-history.mjs record-rollback ${target_release} ${target_commit} ${target_digest} ${target_env} ${target_schema} ${current_release} ${target_release} applied"
  exit 0
fi

# ---- APPLY MODE ----

# 1. Define ENV_DIR/ENV_BASE
ENV_DIR="$(dirname "$ENV_FILE")"
ENV_BASE="$(basename "$ENV_FILE")"

# 2. Acquire exclusive lock to prevent concurrent apply races (before any apply-side writes)
LOCK_DIR="${ENV_DIR}/${ENV_BASE}.rollback-lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "another rollback apply is in progress; aborting" >&2
  exit 15
fi
LOCK_HELD=1

# 3. Database backup
echo "Taking database backup..."
bash "$BACKUP_SCRIPT"
echo "Backup completed."

# 4. Backup env file (same directory, cp -p for byte-for-byte + mode)
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ENV_BACKUP="${ENV_DIR}/${ENV_BASE}.rollback-backup.${TIMESTAMP}"
cp -p "$ENV_FILE" "$ENV_BACKUP"
echo "Env file backed up to: $ENV_BACKUP"

# 3. Atomic update of APP_IMAGE_REF and RELEASE_ID in env file (same directory, preserve mode)
TMP_ENV="${ENV_DIR}/${ENV_BASE}.rollback-tmp.${TIMESTAMP}"
# Preserve original mode: fail-closed portable validation
get_orig_mode() {
  local file="$1"
  local mode=""
  mode="$(stat -c "%a" -- "$file" 2>/dev/null || true)"
  if [[ -n "$mode" && "$mode" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s' "$mode"
    return 0
  fi
  mode="$(stat -f "%Lp" "$file" 2>/dev/null || true)"
  if [[ -n "$mode" && "$mode" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s' "$mode"
    return 0
  fi
  return 1
}
ORIG_MODE="$(get_orig_mode "$ENV_FILE")" || {
  echo "failed to determine original file mode for $ENV_FILE" >&2
  exit 16
}
awk -v img="${target_digest}" -v rel="${target_release}" '
  BEGIN { img_done=0; rel_done=0 }
  /^APP_IMAGE_REF=/ { print "APP_IMAGE_REF=" img; img_done=1; next }
  /^RELEASE_ID=/ { print "RELEASE_ID=" rel; rel_done=1; next }
  { print }
  END {
    if (!img_done) print "APP_IMAGE_REF=" img;
    if (!rel_done) print "RELEASE_ID=" rel;
  }
' "$ENV_FILE" > "$TMP_ENV"
chmod "$ORIG_MODE" "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"
TMP_ENV=""
echo "Updated ${ENV_FILE}: APP_IMAGE_REF=${target_digest} RELEASE_ID=${target_release}"

# 4. Restart systemd unit
echo "Restarting ${SERVICE_UNIT}..."
if ! systemctl restart "${SERVICE_UNIT}"; then
  echo "systemctl restart failed. Restoring env file..." >&2
  if ! restore_env; then
    echo "restore failed" >&2
  fi
  # Record failed rollback event
  "$NODE_BIN" "$HISTORY_MJS" record-rollback "${target_release}" "${target_commit}" "${target_digest}" "${target_env}" "${target_schema}" "${current_release}" "${target_release}" "failed" 2>/dev/null || true
  exit 12
fi

# 5. Healthcheck
HEALTH_URL="${HEALTHCHECK_URL:-}"
if [[ -z "$HEALTH_URL" ]]; then
  HEALTH_URL="$(grep '^HEALTHCHECK_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
fi
if [[ -z "$HEALTH_URL" ]]; then
  HEALTH_URL="http://127.0.0.1:4173/healthz"
fi

echo "Waiting for healthcheck at ${HEALTH_URL} via healthcheck.sh..."
HEALTH_OK=0
for i in {1..30}; do
  if bash "$HEALTHCHECK_SCRIPT" "$HEALTH_URL" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done

if [[ $HEALTH_OK -eq 0 ]]; then
  echo "Healthcheck failed after 30 attempts. Restoring env file and restarting previous release..." >&2
  if ! restore_env; then
    echo "restore failed" >&2
  fi
  # Record failed rollback event
  "$NODE_BIN" "$HISTORY_MJS" record-rollback "${target_release}" "${target_commit}" "${target_digest}" "${target_env}" "${target_schema}" "${current_release}" "${target_release}" "failed" 2>/dev/null || true
  exit 13
fi

echo "Healthcheck passed."

# 6. Record successful rollback event (status=applied)
"$NODE_BIN" "$HISTORY_MJS" record-rollback "${target_release}" "${target_commit}" "${target_digest}" "${target_env}" "${target_schema}" "${current_release}" "${target_release}" "applied" || {
  echo "Failed to record applied rollback event. Restoring env file and restarting previous release..." >&2
  if ! restore_env; then
    echo "restore failed" >&2
  fi
  # Record failed rollback event (attempt, but don't mask the required nonzero exit)
  "$NODE_BIN" "$HISTORY_MJS" record-rollback "${target_release}" "${target_commit}" "${target_digest}" "${target_env}" "${target_schema}" "${current_release}" "${target_release}" "failed" 2>/dev/null || true
  exit 14
}

echo "Rollback completed successfully."
echo "  from: ${current_release} (${current_digest})"
echo "  to  : ${target_release} (${target_digest})"