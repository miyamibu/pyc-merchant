#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

TARGET_URL="${1:-${APP_HEALTH_URL:-http://127.0.0.1:${APP_PORT:-${PORT:-4173}}/healthz}}"

node - "$TARGET_URL" <<'NODE'
const targetUrl = process.argv[2];
if (!targetUrl) {
  console.error("healthcheck target URL is required");
  process.exit(1);
}
fetch(targetUrl)
  .then(async (response) => {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`healthcheck failed: ${response.status} ${body}`);
      process.exit(1);
    }
    const body = await response.text().catch(() => "");
    process.stdout.write(body || "ok\n");
    process.exit(0);
  })
  .catch((error) => {
    console.error(String(error.message || error));
    process.exit(1);
  });
NODE
