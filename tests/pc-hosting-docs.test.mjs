import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("pc hosting runbook keeps pay.miyamibu.xyz as the final public URL across direct and tunnel modes", () => {
  const guide = read("docs/pc-domain-hosting-runbook.md");
  assert.match(guide, /APP_HOST=https:\/\/pay\.miyamibu\.xyz/);
  assert.match(guide, /PAY_BASE_URL=https:\/\/pay\.miyamibu\.xyz/);
  assert.match(guide, /PUBLIC_BASE_URL=https:\/\/pay\.miyamibu\.xyz/);
  assert.match(guide, /CORS_ALLOW_ORIGINS=https:\/\/pay\.miyamibu\.xyz/);
  assert.match(guide, /Caddy/);
  assert.match(guide, /Cloudflare Tunnel fallback/);
  assert.match(guide, /fixed QR は final public URL が確定するまで本印刷しない/);
});

test("deployment templates target the local app while preserving pay.miyamibu.xyz as the public host", () => {
  const caddy = read("deploy/caddy/Caddyfile.example");
  const cloudflared = read("deploy/cloudflared/config.example.yml");
  assert.match(caddy, /pay\.miyamibu\.xyz/);
  assert.match(caddy, /redir https:\/\/pay\.miyamibu\.xyz\{uri\} permanent/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:4173/);
  assert.match(cloudflared, /hostname: pay\.miyamibu\.xyz/);
  assert.match(cloudflared, /service: http:\/\/127\.0\.0\.1:4173/);
});

test("README and deployment docs point operators to the PC hosting runbook and final URL rule", () => {
  const readme = read("README.md");
  const deployment = read("docs/71-production-deployment.md");
  const qrSpec = read("docs/40-qr-spec.md");
  assert.match(readme, /docs\/pc-domain-hosting-runbook\.md/);
  assert.match(readme, /fixed QR は最終URL確定後に作ります/);
  assert.match(deployment, /https:\/\/pay\.miyamibu\.xyz/);
  assert.match(deployment, /Cloudflare Tunnel fallback/);
  assert.match(qrSpec, /final public URL が確定する前に fixed QR を本印刷しない/);
});
