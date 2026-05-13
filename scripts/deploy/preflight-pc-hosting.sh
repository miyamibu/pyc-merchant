#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env.production}"
MODE="${2:-auto}"

if [[ "$MODE" != "auto" && "$MODE" != "direct" && "$MODE" != "tunnel" ]]; then
  echo "pc hosting preflight failed: mode must be auto, direct, or tunnel" >&2
  exit 1
fi

bash ./scripts/deploy/preflight.sh "$ENV_FILE"

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

node - "$MODE" <<'NODE'
const mode = process.argv[2] || "auto";
const values = {
  APP_HOST: process.env.APP_HOST || "",
  PAY_BASE_URL: process.env.PAY_BASE_URL || "",
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",
};

const parsed = {};
for (const [key, raw] of Object.entries(values)) {
  if (!raw) {
    console.error(`pc hosting preflight failed: ${key} is empty`);
    process.exit(1);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error(`pc hosting preflight failed: ${key} must be a valid absolute URL`);
    process.exit(1);
  }
  if (url.protocol !== "https:") {
    console.error(`pc hosting preflight failed: ${key} must use https`);
    process.exit(1);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    console.error(`pc hosting preflight failed: ${key} must be an origin-only URL`);
    process.exit(1);
  }
  if (!url.hostname.startsWith("pay.")) {
    console.error(`pc hosting preflight failed: ${key} hostname must start with pay.`);
    process.exit(1);
  }
  parsed[key] = url.toString().replace(/\/$/, "");
}

if (new Set(Object.values(parsed)).size !== 1) {
  console.error("pc hosting preflight failed: APP_HOST, PAY_BASE_URL, and PUBLIC_BASE_URL must match exactly");
  process.exit(1);
}

console.log(`pc hosting preflight ok: final public URL ${parsed.APP_HOST}`);
console.log(`hosting mode: ${mode}`);
NODE

if [[ "$MODE" == "direct" ]]; then
  if ! command -v caddy >/dev/null 2>&1; then
    echo "pc hosting preflight failed: caddy command not found for direct mode" >&2
    exit 1
  fi
  echo "direct mode check ok: caddy command detected"
fi

if [[ "$MODE" == "tunnel" ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "pc hosting preflight failed: cloudflared command not found for tunnel mode" >&2
    exit 1
  fi
  echo "tunnel mode check ok: cloudflared command detected"
fi

echo "pc hosting preflight complete: $ENV_FILE"
