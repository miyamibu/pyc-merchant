#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function commandExists(command) {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (_error) {
    return false;
  }
}

function getArgMap(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.split("=", 2);
    const key = rawKey.slice(2);
    if (inlineValue != null) {
      args.set(key, inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i += 1;
      continue;
    }
    args.set(key, "true");
  }
  return args;
}

export function parseGitHubRepoFromRemote(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value) return null;
  const sshMatch = value.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch (_error) {
    return null;
  }
}

function getRepoFromGitRemote() {
  try {
    const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseGitHubRepoFromRemote(remoteUrl);
  } catch (_error) {
    return null;
  }
}

function getCurrentGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch (_error) {
    return null;
  }
}

function getTokenFromGhCli() {
  if (!commandExists("gh")) return null;
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token || null;
  } catch (_error) {
    return null;
  }
}

export function getVerificationPolicy(run) {
  const event = String(run?.event || "");
  return {
    requireEvidenceJob: event === "push",
    requireEvidenceArtifact: event === "push",
    requiredJobs: event === "push" ? ["validate", "production-validation-evidence"] : ["validate"],
    requiredValidateSteps: [
      "Verify exact source SHA",
      "Check",
      "Test",
      "Audit",
      "Audit chain",
      "Deploy check",
      "Smoke",
      "Docker version",
      "Docker build",
      "Verify image source label",
      "Docker compose config",
      "Upload CI build metadata",
    ],
  };
}

async function githubRequest(pathName, token) {
  const response = await fetch(`https://api.github.com${pathName}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "jpyc-terminal-ci-verifier",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${data.message || "request failed"}`);
  }
  return data;
}

async function resolveWorkflow(repo, token, workflowRef) {
  if (/^\d+$/.test(workflowRef)) return workflowRef;
  const workflows = await githubRequest(`/repos/${repo}/actions/workflows?per_page=100`, token);
  const target = (workflows.workflows || []).find((workflow) => {
    return workflow.name === workflowRef
      || workflow.path?.endsWith(`/${workflowRef}`)
      || workflow.path === `.github/workflows/${workflowRef}`;
  });
  if (!target) {
    throw new Error(`workflow not found: ${workflowRef}`);
  }
  return String(target.id);
}

async function resolveRun(repo, token, options) {
  if (options.runId) {
    return githubRequest(`/repos/${repo}/actions/runs/${options.runId}`, token);
  }
  const workflowId = await resolveWorkflow(repo, token, options.workflow);
  const params = new URLSearchParams({ per_page: "20" });
  if (options.branch) params.set("branch", options.branch);
  if (options.event) params.set("event", options.event);
  if (options.expectedSha) params.set("head_sha", options.expectedSha);
  const runs = await githubRequest(`/repos/${repo}/actions/workflows/${workflowId}/runs?${params.toString()}`, token);
  const run = (runs.workflow_runs || [])[0];
  if (!run) {
    throw new Error("no matching workflow run found");
  }
  return run;
}

function findJob(jobs, name) {
  return jobs.find((job) => String(job.name || "").trim() === name) || null;
}

function findStep(job, stepName) {
  return (job?.steps || []).find((step) => String(step.name || "").trim() === stepName) || null;
}

export function verifyRunContract({ run, jobs, artifacts, expectedSha = null }) {
  const policy = getVerificationPolicy(run);
  const failures = [];
  const runSha = String(run?.head_sha || "").trim().toLowerCase();
  const requiredSha = String(expectedSha || "").trim().toLowerCase();
  if (requiredSha && runSha !== requiredSha) {
    failures.push(`workflow head SHA ${runSha || "missing"} does not match expected SHA ${requiredSha}`);
  }
  if (run.conclusion !== "success") {
    failures.push(`workflow conclusion is ${run.conclusion || "unknown"}`);
  }

  const validateJob = findJob(jobs, "validate");
  if (!validateJob) {
    failures.push("validate job is missing");
  } else if (validateJob.conclusion !== "success") {
    failures.push(`validate job conclusion is ${validateJob.conclusion || "unknown"}`);
  } else {
    for (const stepName of policy.requiredValidateSteps) {
      const step = findStep(validateJob, stepName);
      if (!step) {
        failures.push(`validate step missing: ${stepName}`);
        continue;
      }
      if (step.conclusion !== "success") {
        failures.push(`validate step ${stepName} conclusion is ${step.conclusion || "unknown"}`);
      }
    }
  }

  for (const jobName of policy.requiredJobs) {
    const job = findJob(jobs, jobName);
    if (!job) {
      failures.push(`required job missing: ${jobName}`);
      continue;
    }
    if (job.conclusion !== "success") {
      failures.push(`required job ${jobName} conclusion is ${job.conclusion || "unknown"}`);
    }
  }

  const buildMetadataName = runSha ? `ci-build-metadata-${runSha}` : null;
  const buildMetadataArtifact = artifacts.find((artifact) => String(artifact.name || "") === buildMetadataName);
  if (!buildMetadataArtifact) {
    failures.push(`exact-SHA CI build metadata artifact is missing: ${buildMetadataName || "head SHA missing"}`);
  } else if (buildMetadataArtifact.expired === true) {
    failures.push("exact-SHA CI build metadata artifact is already expired");
  }

  if (policy.requireEvidenceArtifact) {
    const evidenceName = runSha ? `production-validation-evidence-${runSha}` : null;
    const evidenceArtifact = artifacts.find((artifact) => String(artifact.name || "") === evidenceName);
    if (!evidenceArtifact) {
      failures.push(`production-validation-evidence artifact is missing: ${evidenceName || "head SHA missing"}`);
    } else if (evidenceArtifact.expired === true) {
      failures.push("production-validation-evidence artifact is already expired");
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    policy,
  };
}

function buildArtifactUiUrl(repo, artifactId) {
  if (!repo || !artifactId) return null;
  return `https://github.com/${repo}/actions/runs/artifacts/${artifactId}`;
}

function toSummary(run, jobs, artifacts, verification, options = {}) {
  const repo = run.repository?.full_name || options.repo || null;
  return {
    ok: verification.ok,
    repo,
    workflow: run.name || null,
    run_id: run.id,
    run_number: run.run_number,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    head_sha: run.head_sha || null,
    html_url: run.html_url,
    workflow_run_url: run.html_url,
    jobs: jobs.map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
    })),
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      id: artifact.id,
      expired: artifact.expired === true,
      size_in_bytes: artifact.size_in_bytes,
      url: buildArtifactUiUrl(repo, artifact.id),
      archive_download_url: artifact.archive_download_url || null,
    })),
    failures: verification.failures,
  };
}

async function main() {
  const args = getArgMap(process.argv.slice(2));
  const repo = args.get("repo") || process.env.GITHUB_REPOSITORY || getRepoFromGitRemote();
  if (!repo) {
    fail("GitHub repository could not be resolved. Pass --repo owner/name, set GITHUB_REPOSITORY, or configure git remote origin.");
  }

  const options = {
    repo,
    workflow: args.get("workflow") || "ci.yml",
    runId: args.get("run-id") || null,
    branch: args.get("branch") || null,
    event: args.get("event") || null,
    expectedSha: args.get("sha") || getCurrentGitSha(),
    dryRun: args.get("dry-run") === "true",
  };

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          repo,
          workflow: options.workflow,
          run_id: options.runId,
          branch: options.branch,
          event: options.event,
          expected_sha: options.expectedSha,
          token_source: process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : process.env.GH_TOKEN ? "GH_TOKEN" : "gh auth token",
        },
        null,
        2
      )
    );
    return;
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getTokenFromGhCli();
  if (!token) {
    const ghInstalled = commandExists("gh");
    const ghHint = ghInstalled
      ? "gh is installed but `gh auth token` was unavailable. Run `gh auth login` or set GITHUB_TOKEN."
      : "gh is not installed. Install gh or set GITHUB_TOKEN / GH_TOKEN.";
    fail(`GitHub token is required to verify GitHub Actions runs. ${ghHint}`);
  }

  const run = await resolveRun(repo, token, options);
  const jobsPayload = await githubRequest(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, token);
  const artifactsPayload = await githubRequest(`/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`, token);
  const jobs = jobsPayload.jobs || [];
  const artifacts = artifactsPayload.artifacts || [];
  const verification = verifyRunContract({ run, jobs, artifacts, expectedSha: options.expectedSha });
  const summary = toSummary(run, jobs, artifacts, verification, { repo });

  console.log(JSON.stringify(summary, null, 2));
  if (!verification.ok) {
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => fail(String(error.message || error)));
}
