import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = process.cwd();

function runNode(scriptPath, args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], { cwd: ROOT }, (error, stdout, stderr) => {
      resolve({
        code: error?.code ?? 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

function writeSyntheticLockfile(dir, packages) {
  const lockfilePath = path.join(dir, "synthetic-package-lock.json");
  fs.writeFileSync(lockfilePath, `${JSON.stringify({
    name: "synthetic-hygiene-lockfile",
    lockfileVersion: 3,
    requires: true,
    packages,
  }, null, 2)}\n`, "utf8");
  return lockfilePath;
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
  assert.ok(payload.checks.some((row) => row.name === "license_unknown_fail_closed" && row.ok === true));
  for (const row of payload.licenses) {
    assert.notEqual(row.license, "UNKNOWN", `license must be declared for ${row.package}`);
  }
});

test("UNKNOWN license in a lockfile fails closed with non-zero exit", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "jpyc-hygiene-unknown-"));
  const lockfilePath = writeSyntheticLockfile(outDir, {
    "": { name: "synthetic-hygiene-lockfile", version: "1.0.0", dependencies: {} },
    "node_modules/mit-licensed-pkg": { version: "1.2.3", license: "MIT" },
    // Missing license field must be exported as UNKNOWN and reject the run.
    "node_modules/mystery-pkg": { version: "0.0.1" },
  });
  const result = await runNode("scripts/production-validation/validate-dependency-docker-hygiene.mjs", [
    "--skip-docker",
    "true",
    "--lockfile",
    lockfilePath,
  ]);
  assert.notEqual(result.code, 0, `validator unexpectedly succeeded:\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  const failureRow = payload.checks.find((row) => row.ok === false);
  assert.ok(failureRow, "failure evidence row must be recorded");
  assert.match(`${failureRow.message}`, /UNKNOWN/i);
});
