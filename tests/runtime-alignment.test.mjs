import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("runtime alignment pins Node 24.17.0 across local metadata, CI, and Docker", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.engines?.node, "24.17.0");
  assert.match(String(pkg.scripts?.["test:serial"] || ""), /--test-concurrency=1/);

  assert.equal(read(".nvmrc").trim(), "24.17.0");
  assert.equal(read(".node-version").trim(), "24.17.0");

  const ci = read(".github/workflows/ci.yml");
  assert.equal((ci.match(/node-version-file:\s*\.node-version/g) || []).length, 2);
  assert.doesNotMatch(ci, /node-version:\s*20(?:\.\d+)?/);

  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /FROM node@sha256:032e78d7e54e352129831743737e3a83171d9cc5b5896f411649c597ce0b11ea AS deps/);
  assert.match(dockerfile, /FROM node@sha256:032e78d7e54e352129831743737e3a83171d9cc5b5896f411649c597ce0b11ea AS runtime/);
});

test("top-level docs explain Node 24.17.0 baseline and serial test fallback", () => {
  const readme = read("README.md");
  assert.match(readme, /Node 24\.17\.0/);
  assert.match(readme, /npm run test:serial/);
});
