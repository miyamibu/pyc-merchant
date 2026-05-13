#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env.production}"
PUBLIC_ENTRY_TOKEN="${2:-}"
SIGNED_PAY_URL="${3:-}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "public host check failed: env file not found: $ENV_FILE" >&2
  exit 1
fi

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

bash ./scripts/deploy/preflight-pc-hosting.sh "$ENV_FILE"
bash ./scripts/deploy/healthcheck.sh "${APP_HOST%/}/healthz"

node - "$PUBLIC_ENTRY_TOKEN" "$SIGNED_PAY_URL" <<'NODE'
const publicEntryToken = process.argv[2] || "";
const signedPayUrl = process.argv[3] || "";
const appHost = (process.env.APP_HOST || "").replace(/\/$/, "");
const metricsSecret = process.env.METRICS_SECRET || "";

if (!appHost) {
  console.error("public host check failed: APP_HOST is empty");
  process.exit(1);
}

async function fetchOk(label, url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} failed: ${response.status} ${body}`);
  }
  console.log(`${label} ok: ${url}`);
}

function normalizePayUrl(raw) {
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  return new URL(raw, `${appHost}/`).toString();
}

(async () => {
  if (!metricsSecret) {
    throw new Error("public host check failed: METRICS_SECRET is empty");
  }

  await fetchOk("readyz", `${appHost}/readyz`, {
    headers: { authorization: `Bearer ${metricsSecret}` },
  });

  if (publicEntryToken) {
    await fetchOk("terminal public entry", `${appHost}/t/${encodeURIComponent(publicEntryToken)}`);
  } else {
    console.log("terminal public entry check skipped: pass <public_entry_token> as arg 2 when ready");
  }

  const payUrl = normalizePayUrl(signedPayUrl);
  if (payUrl) {
    await fetchOk("signed pay url", payUrl);
  } else {
    console.log("signed pay url check skipped: pass full URL or /pay?... as arg 3 when ready");
  }
})().catch((error) => {
  console.error(String(error.message || error));
  process.exit(1);
});
NODE

echo "public host check complete: ${APP_HOST%/}"
