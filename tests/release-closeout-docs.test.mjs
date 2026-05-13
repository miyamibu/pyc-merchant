import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("execution roadmap reflects implemented core instead of pre-implementation state", () => {
  const roadmap = read("docs/82-execution-roadmap.md");
  assert.match(roadmap, /implemented core/i);
  assert.match(roadmap, /production validation pack `PASS`/);
  assert.doesNotMatch(roadmap, /現在は実装前。/);
  assert.doesNotMatch(roadmap, /Do Not Start Yet/);
  assert.doesNotMatch(roadmap, /未作成候補/);
});

test("commercial closeout docs use the machine verdict names exposed by the validator", () => {
  const scorecard = read("docs/96-commercial-go-scorecard.md");
  assert.match(scorecard, /CONDITIONAL_NO_GO_FOR_COMMERCIAL/);
  assert.match(scorecard, /COMMERCIAL_GO_10/);
  assert.match(scorecard, /COMMERCIAL_GO_MODE/);

  const runbook = read("docs/commercial/commercial-go-runbook.md");
  assert.match(runbook, /NO_GO/);
  assert.match(runbook, /CONDITIONAL_NO_GO_FOR_COMMERCIAL/);
});

test("approval pack ties minutes and release record to the same closeout artifacts", () => {
  const packIndex = read("docs/83-approval-pack-index.md");
  const minutes = read("docs/88-approval-minutes-and-signoff.md");
  const releaseRecord = read("docs/97-commercial-release-record-template.md");

  assert.match(packIndex, /docs\/97-commercial-release-record-template\.md/);
  assert.match(packIndex, /Machine verdict/);

  assert.match(minutes, /Machine verdict/);
  assert.match(minutes, /Human meeting verdict/);
  assert.match(minutes, /EXT-001/);

  assert.match(releaseRecord, /Machine verdict/);
  assert.match(releaseRecord, /Human meeting verdict/);
  assert.match(releaseRecord, /Approval minutes/);
});

test("production validation plan and evidence README use canonical EXT-002 naming and POC artifacts", () => {
  const validationPlan = read("docs/90-production-validation-plan.md");
  const evidenceReadme = read("docs/production/evidence/README.md");

  assert.match(validationPlan, /EXT-002-wallet-device-launch\.md/);
  assert.match(validationPlan, /POC-001\.md/);
  assert.match(validationPlan, /backward-compatible alias/);

  assert.match(evidenceReadme, /EXT-002-wallet-device-launch\.md/);
  assert.match(evidenceReadme, /POC-001\.md/);
});
