#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

TARGET_URL="${1:-${APP_HEALTH_URL:-http://127.0.0.1:${APP_PORT:-${PORT:-4173}}/healthz}}"

node --input-type=module - "$TARGET_URL" <<'NODE'
import { fetchPinnedPublicHttps } from "./src/public-endpoint-security.mjs";

const targetUrl = process.argv[2];
if (!targetUrl) {
  console.error("healthcheck target URL is required");
  process.exit(1);
}
const parsed = new URL(targetUrl);
const check = parsed.protocol === "https:"
  ? fetchPinnedPublicHttps(targetUrl)
  : fetch(targetUrl, { redirect: "manual" }).then(async (response) => ({
      status: response.status,
      body: await response.text().catch(() => ""),
    }));
check
  .then((response) => {
    if (response.status < 200 || response.status >= 300) {
      console.error(`healthcheck failed: ${response.status} ${response.body}`);
      process.exit(1);
    }
    process.stdout.write(response.body || "ok\n");
    process.exit(0);
  })
  .catch((error) => {
    console.error(String(error.message || error));
    process.exit(1);
  });
NODE
