#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env.production}"
PUBLIC_ENTRY_TOKEN="${2:-}"
SIGNED_PAY_URL="${3:-}"

if [[ -z "$PUBLIC_ENTRY_TOKEN" || -z "$SIGNED_PAY_URL" ]]; then
  echo "public host check failed: public_entry_token and signed_pay_url are required" >&2
  echo "usage: $0 <env-file> <public_entry_token> '<signed_pay_url>'" >&2
  exit 1
fi

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

node --input-type=module - "$PUBLIC_ENTRY_TOKEN" "$SIGNED_PAY_URL" <<'NODE'
import { fetchPinnedPublicHttps } from "./src/public-endpoint-security.mjs";

const publicEntryToken = process.argv[2] || "";
const signedPayUrl = process.argv[3] || "";
const appHost = (process.env.APP_HOST || "").replace(/\/$/, "");
const metricsSecret = process.env.METRICS_SECRET || "";
const appHostParsed = new URL(appHost || "https://invalid.example");
const expectedHostname = appHostParsed.hostname;

if (!appHost) {
  console.error("public host check failed: APP_HOST is empty");
  process.exit(1);
}
if (appHostParsed.protocol !== "https:" || appHostParsed.port || appHostParsed.pathname !== "/" || appHostParsed.search || appHostParsed.hash) {
  console.error("public host check failed: APP_HOST must be an origin-only HTTPS URL on port 443");
  process.exit(1);
}

async function fetchOk(label, url, options = {}) {
  const response = await fetchPinnedPublicHttps(url, {
    headers: options.headers || {},
    expectedHostname,
    maxRedirects: 3,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} failed: ${response.status} ${response.body}`);
  }
  if (options.expectReadyJson) {
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error(`${label} failed: response was not valid JSON`);
    }
    if (payload?.ok !== true || payload?.commercial_verdict === "NO_GO" || payload?.commercial_verdict === "CONDITIONAL_NO_GO_FOR_COMMERCIAL") {
      throw new Error(`${label} failed: readiness payload is not ready (${response.body})`);
    }
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
    expectReadyJson: true,
  });

  await fetchOk("terminal public entry", `${appHost}/t/${encodeURIComponent(publicEntryToken)}`);

  const payUrl = normalizePayUrl(signedPayUrl);
  if (!payUrl) throw new Error("public host check failed: signed pay URL is empty");
  await fetchOk("signed pay url", payUrl);
})().catch((error) => {
  console.error(String(error.message || error));
  process.exit(1);
});
NODE

echo "public host check complete: ${APP_HOST%/}"
