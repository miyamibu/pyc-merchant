import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = process.cwd();

function runNode(scriptPath, args = [], env = {}) {
  return new Promise((resolve) => {
    execFile("node", [scriptPath, ...args], { cwd: ROOT, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({
        code: error?.code ?? 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

test("dependency and docker hygiene validator exports licenses and passes static checks", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "jpyc-hygiene-"));
  const output = path.join(outDir, "licenses.json");
  const result = await runNode("scripts/production-validation/validate-dependency-docker-hygiene.mjs", [
    "--skip-docker",
    "true",
    "--output",
    output,
  ]);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.licenses));
  assert.ok(payload.licenses.length > 0);
  assert.ok(payload.checks.some((row) => row.name === "dockerignore_secret_patterns" && row.ok === true));
});

test("dependency and docker hygiene validator fails closed for mutable resolved production images", async () => {
  const result = await runNode("scripts/production-validation/validate-dependency-docker-hygiene.mjs", [
    "--skip-docker",
    "true",
    "--require-resolved-digests",
    "true",
  ], {
    PRODUCTION_NODE_IMAGE: "node:24.17.0-bookworm-slim",
    PRODUCTION_NGINX_IMAGE: "nginx:1.27-alpine",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /PRODUCTION_NODE_IMAGE must be a production digest-pinned image|PRODUCTION_NGINX_IMAGE must be a production digest-pinned image/);
});
