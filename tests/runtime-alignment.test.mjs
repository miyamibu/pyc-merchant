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
  assert.match(String(pkg.scripts?.test || ""), /scripts\/run-node-tests\.mjs/);
  assert.match(String(pkg.scripts?.["test:serial"] || ""), /scripts\/run-node-tests\.mjs --serial/);

  assert.equal(read(".nvmrc").trim(), "24.17.0");
  assert.equal(read(".node-version").trim(), "24.17.0");

  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /node-version:\s*24\.17\.0/);

  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /ARG NODE_IMAGE=node:24\.17\.0-bookworm-slim/);
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS deps/);
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS runtime/);
});

test("top-level docs explain Node 24.17.0 baseline and serial test fallback", () => {
  const readme = read("README.md");
  assert.match(readme, /Node 24\.17\.0/);
  assert.match(readme, /npm run test:serial/);
});
