import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const CI_WORKFLOW = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
const SMOKE_SCRIPT = fs.readFileSync(path.join(ROOT, "scripts/smoke-test.mjs"), "utf8");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing contract marker: ${startMarker}`);
  assert.ok(end > start, `missing contract end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("smoke uses the seeded approver and preserves staff role separation", () => {
  assert.match(SMOKE_SCRIPT, /const SECOND_ADMIN_STAFF_NAME = "Demo Approver";/);
  assert.doesNotMatch(SMOKE_SCRIPT, /SECOND_ADMIN_NAME/);
  assert.doesNotMatch(SMOKE_SCRIPT, /smoke-create-approver/);
  assert.match(SMOKE_SCRIPT, /loginAs\(SECOND_ADMIN_PIN, SECOND_ADMIN_STAFF_NAME\)/);
  assert.match(SMOKE_SCRIPT, /staff_user_id === "staff-002"/);

  const rejectedAdminBlock = sliceBetween(SMOKE_SCRIPT, "const rejectedAdminCreation", "const allowedStaffCreation");
  assert.match(rejectedAdminBlock, /role: "admin"/);
  assert.match(rejectedAdminBlock, /status === 403/);
  assert.match(rejectedAdminBlock, /STAFF_SECURITY_APPROVAL_REQUIRED/);

  const allowedStaffBlock = sliceBetween(SMOKE_SCRIPT, "const allowedStaffCreation", "const approverLogin");
  assert.match(allowedStaffBlock, /role: "staff"/);
  assert.match(allowedStaffBlock, /status === 201/);
});

test("smoke daily close derives the date from the store timezone", () => {
  const source = sliceBetween(SMOKE_SCRIPT, "function businessDateForStoreTimezone", "function randomTxHash");
  const context = vm.createContext({ Date, Intl });
  vm.runInContext(`${source}\nthis.businessDateForTest = businessDateForStoreTimezone;`, context);

  assert.equal(
    context.businessDateForTest(new Date("2026-07-26T15:30:00.000Z"), "Asia/Tokyo"),
    "2026-07-27",
  );
  assert.equal(
    context.businessDateForTest(new Date("2026-07-26T15:30:00.000Z"), "America/Los_Angeles"),
    "2026-07-26",
  );
  assert.match(SMOKE_SCRIPT, /daily:preview/);
  assert.match(SMOKE_SCRIPT, /businessDateForStoreTimezone\(new Date\(\), storeTimezone\)/);
  assert.doesNotMatch(SMOKE_SCRIPT, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
});

test("CI isolates smoke runtime data and delays build metadata until required checks pass", () => {
  const smokeBlock = sliceBetween(CI_WORKFLOW, "      - name: Smoke", "      - name: Audit chain");
  assert.match(smokeBlock, /mktemp -d/);
  assert.match(smokeBlock, /DB_PATH=.*SMOKE_ROOT.*app\.db/);
  assert.match(smokeBlock, /BACKUP_DIR=.*SMOKE_ROOT.*backups/);
  assert.match(smokeBlock, /RECEIVE_ADDRESS_DEV_AUTO_VERIFY/);
  assert.match(smokeBlock, /GITHUB_ENV/);
  assert.match(smokeBlock, /per-smoke -wal and -shm/);

  const metadataMarker = "      - name: Generate CI build metadata after required checks";
  const metadataIndex = CI_WORKFLOW.indexOf(metadataMarker);
  const composeIndex = CI_WORKFLOW.indexOf("      - name: Docker compose config");
  assert.ok(metadataIndex > composeIndex, "build metadata must be generated after compose validation");
  assert.match(CI_WORKFLOW.slice(metadataIndex, metadataIndex + 700), /if: success\(\)/);

  for (const requiredStep of [
    "Verify exact source SHA",
    "Check",
    "Test",
    "Audit",
    "Commercial gate fails closed without production evidence",
    "Limited gate fails closed without production evidence",
    "Deploy check",
    "Smoke",
    "Audit chain",
    "Docker version",
    "Docker build",
    "Verify image source label",
    "Docker compose config",
  ]) {
    const stepIndex = CI_WORKFLOW.indexOf(`      - name: ${requiredStep}`);
    assert.ok(stepIndex >= 0 && stepIndex < metadataIndex, `${requiredStep} must precede metadata generation`);
  }

  const dockerBuildBlock = sliceBetween(CI_WORKFLOW, "      - name: Docker build", "      - name: Verify image source label");
  assert.doesNotMatch(dockerBuildBlock, /build-metadata\.json/);
  assert.equal((CI_WORKFLOW.match(/node-version-file: \.node-version/g) || []).length, 2);
  assert.doesNotMatch(CI_WORKFLOW, /node-version:\s*20(?:\.\d+)?/);
});
