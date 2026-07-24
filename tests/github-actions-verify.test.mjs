import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { getVerificationPolicy, parseGitHubRepoFromRemote, verifyRunContract } from "../scripts/ci/verify-github-actions-run.mjs";

const SHA = "4c1901b7736a6e1818baf1a6407dc85bce66aeef";

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
      "node",
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
