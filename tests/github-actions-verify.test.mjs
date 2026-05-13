import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { getVerificationPolicy, parseGitHubRepoFromRemote, verifyRunContract } from "../scripts/ci/verify-github-actions-run.mjs";

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
    run: { event: "pull_request", conclusion: "success" },
    jobs: [
      {
        name: "validate",
        conclusion: "success",
        steps: [
          { name: "Check", conclusion: "success" },
          { name: "Test", conclusion: "success" },
          { name: "Audit", conclusion: "success" },
          { name: "Audit chain", conclusion: "success" },
          { name: "Deploy check", conclusion: "success" },
          { name: "Smoke", conclusion: "success" },
          { name: "Docker version", conclusion: "success" },
          { name: "Docker build", conclusion: "success" },
          { name: "Docker compose config", conclusion: "success" },
        ],
      },
    ],
    artifacts: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("verifyRunContract rejects push run missing production validation artifact", () => {
  const result = verifyRunContract({
    run: { event: "push", conclusion: "success" },
    jobs: [
      {
        name: "validate",
        conclusion: "success",
        steps: [
          { name: "Check", conclusion: "success" },
          { name: "Test", conclusion: "success" },
          { name: "Audit", conclusion: "success" },
          { name: "Audit chain", conclusion: "success" },
          { name: "Deploy check", conclusion: "success" },
          { name: "Smoke", conclusion: "success" },
          { name: "Docker version", conclusion: "success" },
          { name: "Docker build", conclusion: "success" },
          { name: "Docker compose config", conclusion: "success" },
        ],
      },
      {
        name: "production-validation-evidence",
        conclusion: "success",
        steps: [],
      },
    ],
    artifacts: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /artifact is missing/);
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
