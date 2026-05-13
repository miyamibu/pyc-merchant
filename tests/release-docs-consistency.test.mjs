import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("MVP evidence matrix keeps EXT ids aligned with blocked external validation", () => {
  const matrix = read("docs/95-mvp-done-evidence-matrix.md");
  assert.match(matrix, /\|\s*実機 HashPort 起動\s*\|[^\n]*`docs\/production\/evidence\/<timestamp>\/EXT-002-\*`/);
  assert.match(matrix, /\|\s*実JPYC 少額決済\s*\|[^\n]*`docs\/production\/evidence\/<timestamp>\/EXT-001-\*`/);
});

test("API spec documents metrics auth for readiness endpoints", () => {
  const apiSpec = read("docs/32-api-spec.md");
  assert.match(apiSpec, /監視系:\s*`Authorization: Bearer <METRICS_SECRET>`/);
  assert.match(apiSpec, /`GET \/readyz`[\s\S]*`Authorization: Bearer <METRICS_SECRET>`/);
  assert.match(apiSpec, /`GET \/metrics`[\s\S]*`Authorization: Bearer <METRICS_SECRET>`/);
});

test("commercial scorecard guide stays free of local temp paths or generated verdict dumps", () => {
  const guide = read("docs/96-commercial-go-scorecard.md");
  assert.doesNotMatch(guide, /\/var\/folders\/|\/tmp\/|jpyc-danger-evidence|Generated at:/);
  assert.match(guide, /generated scorecard は validation output dir に保存する/);
});
