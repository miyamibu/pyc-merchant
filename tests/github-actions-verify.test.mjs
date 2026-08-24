import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { getVerificationPolicy, parseGitHubRepoFromRemote, verifyRunContract } from "../scripts/ci/verify-github-actions-run.mjs";

const SHA = "4c1901b7736a6e1818baf1a6407dc85bce66aeef";

const CI_WORKFLOW_PATH = path.join(process.cwd(), ".github/workflows/ci.yml");
const CI_WORKFLOW = fs.readFileSync(CI_WORKFLOW_PATH, "utf8");

test("parseGitHubRepoFromRemote supports ssh and https remotes", () => {
  assert.equal(parseGitHubRepoFromRemote("git@github.com:openai/example.git"), "openai/example");
  assert.equal(parseGitHubRepoFromRemote("https://github.com/openai/example.git"), "openai/example");
  assert.equal(parseGitHubRepoFromRemote("https://gitlab.com/openai/example.git"), null);
});

test("getVerificationPolicy requires evidence job for push only", () => {
  assert.equal(getVerificationPolicy({ event: "pull_request" }).requireEvidenceArtifact, false);
  assert.equal(getVerificationPolicy({ event: "push" }).requireEvidenceArtifact, true);
  assert.deepEqual(getVerificationPolicy({ event: "push" }).requiredJobs, ["validate", "production-validation-evidence"]);
});

test("verifyRunContract accepts successful pull request run without evidence artifact", () => {
  const result = verifyRunContract({
    run: { event: "pull_request", conclusion: "success", head_sha: SHA },
    jobs: [
      {
        name: "validate",
        conclusion: "success",
        steps: [
          { name: "Verify exact source SHA", conclusion: "success" },
          { name: "Check", conclusion: "success" },
          { name: "Test", conclusion: "success" },
          { name: "Audit", conclusion: "success" },
          { name: "Audit chain", conclusion: "success" },
          { name: "Deploy check", conclusion: "success" },
          { name: "Smoke", conclusion: "success" },
          { name: "Docker version", conclusion: "success" },
          { name: "Docker build", conclusion: "success" },
          { name: "Verify image source label", conclusion: "success" },
          { name: "Docker compose config", conclusion: "success" },
          { name: "Upload CI build metadata", conclusion: "success" },
        ],
      },
    ],
    artifacts: [{ name: `ci-build-metadata-${SHA}`, expired: false }],
    expectedSha: SHA,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("verifyRunContract rejects push run missing production validation artifact", () => {
  const result = verifyRunContract({
    run: { event: "push", conclusion: "success", head_sha: SHA },
    jobs: [
      {
        name: "validate",
        conclusion: "success",
        steps: [
          { name: "Verify exact source SHA", conclusion: "success" },
          { name: "Check", conclusion: "success" },
          { name: "Test", conclusion: "success" },
          { name: "Audit", conclusion: "success" },
          { name: "Audit chain", conclusion: "success" },
          { name: "Deploy check", conclusion: "success" },
          { name: "Smoke", conclusion: "success" },
          { name: "Docker version", conclusion: "success" },
          { name: "Docker build", conclusion: "success" },
          { name: "Verify image source label", conclusion: "success" },
          { name: "Docker compose config", conclusion: "success" },
          { name: "Upload CI build metadata", conclusion: "success" },
        ],
      },
      {
        name: "production-validation-evidence",
        conclusion: "success",
        steps: [],
      },
    ],
    artifacts: [{ name: `ci-build-metadata-${SHA}`, expired: false }],
    expectedSha: SHA,
  });

  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /artifact is missing/);
});

test("verifyRunContract rejects a successful run for a different SHA", () => {
  const result = verifyRunContract({
    run: { event: "pull_request", conclusion: "success", head_sha: "a".repeat(40) },
    jobs: [],
    artifacts: [],
    expectedSha: SHA,
  });

  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /does not match expected SHA/);
});

test("ci verify dry-run works without token and echoes resolved options", async () => {
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["scripts/ci/verify-github-actions-run.mjs", "--repo", "openai/example", "--workflow", "ci.yml", "--dry-run"],
      { cwd: process.cwd(), env: { PATH: process.env.PATH || "" } },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      }
    );
  });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.dry_run, true);
  assert.equal(payload.repo, "openai/example");
});

const PINNED_ACTIONS = [
  { action: "actions/checkout", sha: "11d5960a326750d5838078e36cf38b85af677262", tag: "v4.4.0" },
  { action: "actions/setup-node", sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", tag: "v4.4.0" },
  { action: "gitleaks/gitleaks-action", sha: "ff98106e4c7b2bc287b24eaf42907196329070c7", tag: "v2.3.9" },
  { action: "actions/upload-artifact", sha: "ea165f8d65b6e75b540449e92b4886f43607fa02", tag: "v4.6.2" },
];

test("ci.yml pins every action to the official tag commit SHA and keeps the tag comment", () => {
  const usesLines = CI_WORKFLOW.split("\n")
    .filter((line) => line.includes("uses:"))
    .map((line) => line.trim().replace(/^-\s*/, ""));
  assert.ok(usesLines.length >= 10, `expected pinned action uses lines, got ${usesLines.length}`);
  for (const line of usesLines) {
    assert.match(
      line,
      /^uses:\s+[^\s]+@[a-f0-9]{40}\s+#\s*v[\w.-]+$/,
      `action reference must be SHA-pinned with a tag comment: ${line}`,
    );
  }
  for (const { action, sha, tag } of PINNED_ACTIONS) {
    const expected = `uses: ${action}@${sha} # ${tag}`;
    const matching = CI_WORKFLOW.split("\n")
      .filter((line) => line.includes(`${action}@`))
      .map((line) => line.trim().replace(/^-\s*/, ""));
    assert.ok(matching.length > 0, `${action} must be used in ci.yml`);
    for (const line of matching) {
      assert.equal(line, expected, `${action} must pin exactly ${expected}`);
    }
  }
  for (const mutableRef of ["@v4", "@v2", "@main", "@master", "@latest"]) {
    assert.ok(!CI_WORKFLOW.includes(mutableRef), `mutable action ref must not appear: ${JSON.stringify(mutableRef)}`);
  }
});

function sliceUiEvidenceJob(source) {
  const start = source.indexOf("  ui-evidence:");
  const end = source.indexOf("  production-validation-evidence:");
  assert.ok(start >= 0 && end > start, "ui-evidence job block must exist");
  return source.slice(start, end);
}

test("ui-evidence job pins Playwright 1.62.1 and never runs mutable npx --yes", () => {
  const job = sliceUiEvidenceJob(CI_WORKFLOW);
  assert.match(CI_WORKFLOW, /PLAYWRIGHT_PINNED_VERSION:\s*"1\.62\.1"/);
  assert.match(job, /run: npm ci$/m);
  assert.doesNotMatch(job, /npm ci --package-lock=false/);
  assert.match(job, /npm install --package-lock=false --no-save --no-audit --no-fund "playwright@\$\{PLAYWRIGHT_PINNED_VERSION\}"/);
  assert.match(job, /node node_modules\/playwright\/cli\.js install --with-deps chromium/);
  assert.match(
    job,
    /require\('\.\/node_modules\/playwright\/package\.json'\)\.version/,
    "installed Playwright version must be verified against the pin",
  );
  assert.doesNotMatch(CI_WORKFLOW, /npx\s+--yes/);
  assert.doesNotMatch(CI_WORKFLOW, /npx\s+playwright/);
});

test("ui-evidence job resolves the browser from the installed registry without find/latest scans", () => {
  const job = sliceUiEvidenceJob(CI_WORKFLOW);
  assert.match(job, /require\('playwright'\)\.chromium\.executablePath\(\)/);
  assert.doesNotMatch(job, /find .*ms-playwright/);
  assert.doesNotMatch(job, /\| sort \| tail -n 1/);
});

test("ui-evidence job verifies evidence with dedicated CLI at deterministic path", () => {
  const job = sliceUiEvidenceJob(CI_WORKFLOW);
  assert.doesNotMatch(job, /find output\/playwright/);
  assert.doesNotMatch(job, /Detect latest UI evidence dir/);
  assert.doesNotMatch(job, /jq -e/);
  assert.match(job, /EVIDENCE_DIR="output\/playwright\/run-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{GITHUB_JOB\}"/);
  assert.doesNotMatch(job, /EVIDENCE_DIR="output\/playwright\/run-\$\{\{/);
  assert.match(job, /node scripts\/verify-ui-evidence\.mjs --evidence-dir "\$\{EVIDENCE_DIR\}"/);
  assert.match(job, /echo "path=\$\{EVIDENCE_DIR\}" >> "\$GITHUB_OUTPUT"/);
});
