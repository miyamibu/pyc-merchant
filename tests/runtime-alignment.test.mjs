import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("runtime alignment pins Node 20 across local metadata, CI, and Docker", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.engines?.node, "20.x");
  assert.match(String(pkg.scripts?.["test:serial"] || ""), /--test-concurrency=1/);

  assert.equal(read(".nvmrc").trim(), "20");
  assert.equal(read(".node-version").trim(), "20");

  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /node-version:\s*20/);

  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /ARG NODE_IMAGE=node:20-bookworm-slim/);
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS deps/);
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS runtime/);
});

test("top-level docs explain Node 20 baseline and serial test fallback", () => {
  const readme = read("README.md");
  assert.match(readme, /Node 20/);
  assert.match(readme, /npm run test:serial/);
});
