import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PINNED_NODE_VERSION,
  parseEnvFileLines,
  resolveRunnerPlan,
} from "../deploy/launchd/run-env-safe.mjs";

const RUNNER_TARGET_FIXTURES = Object.freeze([
  "src/server.mjs",
  "src/chain-monitor.mjs",
  "scripts/verify-audit-chain.mjs",
  "deploy/launchd/targets/backup-sqlite.mjs",
  "deploy/launchd/targets/health-watch.mjs",
]);

function makeTempRepo({ envFileBody = "", envFileName = ".env.production", envFileMode = 0o600 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jpyc-launchd-runner-"));
  for (const target of RUNNER_TARGET_FIXTURES) {
    fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
    fs.writeFileSync(path.join(root, target), "// fixture\n");
  }
  if (envFileBody !== null) {
    const envPath = path.join(root, envFileName);
    fs.writeFileSync(envPath, envFileBody);
    fs.chmodSync(envPath, envFileMode);
  }
  return root;
}

function baseArgs(root, extra = []) {
  return [
    "--cwd", root,
    "--env-file", path.join(root, ".env.production"),
    "--allow-exec", process.execPath,
    ...extra,
  ];
}

test("runner pins the Node 24.17.0 runtime", () => {
  assert.equal(PINNED_NODE_VERSION, "v24.17.0");
});

test("resolveRunnerPlan refuses any runtime other than the pinned version", () => {
  const root = makeTempRepo({ envFileBody: "A=1\n" });
  try {
    const argv = [...baseArgs(root), "--", "src/server.mjs"];
    const matching = resolveRunnerPlan(argv, { runtimeVersion: "v24.17.0" });
    assert.equal(matching.ok, true, JSON.stringify(matching));
    const mismatched = resolveRunnerPlan(argv, { runtimeVersion: "v26.7.0" });
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.code, "node_version_mismatch");
    // The default (production) path enforces the pin against process.version.
    if (process.version !== PINNED_NODE_VERSION) {
      const defaultRuntime = resolveRunnerPlan(argv, {});
      assert.equal(defaultRuntime.code, "node_version_mismatch");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseEnvFileLines accepts strict KEY=VALUE lines and keeps values verbatim", () => {
  const { values, errors } = parseEnvFileLines(
    [
      "# comment",
      "",
      "APP_ENV=production",
      "APP_SECRET=abc$(touch /tmp/never-executed)def`id`'quoted'",
      "PAYMENT_PAGE=false # not a trailing comment: verbatim",
      "SPACED_VALUE=  keep both sides  ",
      "_PRIVATE_FLAG=1",
    ].join("\n")
  );
  assert.deepEqual(errors, []);
  assert.equal(values.get("APP_ENV"), "production");
  // Shell metacharacters are inert data: preserved literally, never executed
  // or expanded, because the child is spawned without a shell.
  assert.equal(values.get("APP_SECRET"), "abc$(touch /tmp/never-executed)def`id`'quoted'");
  assert.equal(values.get("PAYMENT_PAGE"), "false # not a trailing comment: verbatim");
  assert.equal(values.get("SPACED_VALUE"), "  keep both sides  ");
  assert.equal(values.get("_PRIVATE_FLAG"), "1");
});

test("parseEnvFileLines rejects malformed env lines with reasons only", () => {
  const { errors } = parseEnvFileLines(
    [
      "GOOD=1",
      "export EXPORTED=1",
      "NO_EQUALS_SIGN",
      "=empty_key",
      "BAD-KEY=1",
      "DUP=1",
      "DUP=2",
      "NUL=value\0suffix",
    ].join("\n")
  );
  const reasons = errors.map((error) => error.reason);
  assert.ok(reasons.includes("export_prefix_unsupported"));
  assert.ok(reasons.includes("missing_equals"));
  assert.ok(reasons.includes("empty_key"));
  assert.ok(reasons.includes("invalid_key"));
  assert.ok(reasons.includes("duplicate_key"));
  assert.ok(reasons.includes("nul_in_value"));
});

function planFor(root, argv = baseArgs(root)) {
  return resolveRunnerPlan(argv, { execPath: process.execPath, runtimeVersion: PINNED_NODE_VERSION });
}

test("production example has unique keys and permits every launchd target plan", () => {
  const raw = fs.readFileSync(path.join(process.cwd(), ".env.production.example"), "utf8");
  assert.deepEqual(parseEnvFileLines(raw).errors, []);
  assert.equal(raw.split("\n").filter((line) => line.startsWith("BACKUP_DIR=")).length, 1);
  const root = makeTempRepo({ envFileBody: raw });
  try {
    for (const target of RUNNER_TARGET_FIXTURES) {
      const result = planFor(root, [...baseArgs(root), "--", target]);
      assert.equal(result.ok, true, `${target}: ${result.code}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRunnerPlan accepts an allowlisted local topology launch", () => {
  const root = makeTempRepo({ envFileBody: "APP_ENV=production\nAPP_PORT=4173\n" });
  try {
    const result = planFor(root, [...baseArgs(root), "--", "src/server.mjs"]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.plan.cwd, fs.realpathSync(root));
    assert.equal(result.plan.env.APP_ENV, "production");
    assert.deepEqual(result.plan.args, ["src/server.mjs"]);
    // Only innocuous ambient variables pass through; everything else must be
    // declared in the env file.
    assert.ok(!("APP_SECRET_TEST_LEAK" in result.plan.env));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRunnerPlan refuses env files without exactly 0600 permissions", () => {
  const root = makeTempRepo({ envFileBody: "A=1\n", envFileMode: 0o644 });
  try {
    const result = planFor(root);
    assert.equal(result.ok, false);
    assert.equal(result.code, "env_file_mode_not_0600");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRunnerPlan refuses invalid env lines instead of guessing", () => {
  const root = makeTempRepo({ envFileBody: "GOOD=1\nexport BAD=2\n" });
  try {
    const result = planFor(root);
    assert.equal(result.ok, false);
    assert.equal(result.code, "env_file_invalid_lines");
    assert.deepEqual(result.lines, [{ line: 2, reason: "export_prefix_unsupported" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRunnerPlan enforces the working directory, env-file location, and name", () => {
  const insideRoot = makeTempRepo({ envFileBody: null });
  try {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "jpyc-launchd-outside-"));
    const outside = path.join(outsideDir, ".env.production");
    fs.writeFileSync(outside, "A=1\n");
    fs.chmodSync(outside, 0o600);
    try {
    const escapedEnv = resolveRunnerPlan(
      ["--cwd", insideRoot, "--env-file", outside, "--allow-exec", process.execPath, "--", "src/server.mjs"],
      { runtimeVersion: PINNED_NODE_VERSION }
    );
    assert.equal(escapedEnv.code, "env_file_outside_cwd");

    const wrongName = path.join(insideRoot, "secrets.txt");
    fs.writeFileSync(wrongName, "A=1\n");
    fs.chmodSync(wrongName, 0o600);
    const badName = resolveRunnerPlan(
      ["--cwd", insideRoot, "--env-file", wrongName, "--allow-exec", process.execPath, "--", "src/server.mjs"],
      { runtimeVersion: PINNED_NODE_VERSION }
    );
    assert.equal(badName.code, "env_file_name_rejected");

    const missingCwd = resolveRunnerPlan(
      ["--env-file", path.join(insideRoot, ".env.production"), "--allow-exec", process.execPath, "--", "src/server.mjs"],
      { runtimeVersion: PINNED_NODE_VERSION }
    );
      assert.equal(missingCwd.code, "cwd_required");
    } finally {
      fs.rmSync(outside, { force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(insideRoot, { recursive: true, force: true });
  }
});

test("resolveRunnerPlan allowlists execution targets inside the working directory", () => {
  const root = makeTempRepo({ envFileBody: "A=1\n" });
  try {
    const okServer = planFor(root, [...baseArgs(root), "--", "src/server.mjs"]);
    assert.equal(okServer.ok, true);
    const okWorker = planFor(root, [...baseArgs(root), "--", "src/chain-monitor.mjs"]);
    assert.equal(okWorker.ok, true);

    // launchd operations added for the local topology: backup, health-watch,
    // and audit-watch targets are accepted alongside the app and worker.
    const okAuditWatch = planFor(root, [...baseArgs(root), "--", "scripts/verify-audit-chain.mjs"]);
    assert.equal(okAuditWatch.ok, true, JSON.stringify(okAuditWatch));
    const okBackup = planFor(root, [...baseArgs(root), "--", "deploy/launchd/targets/backup-sqlite.mjs"]);
    assert.equal(okBackup.ok, true, JSON.stringify(okBackup));
    const okHealthWatch = planFor(root, [...baseArgs(root), "--", "deploy/launchd/targets/health-watch.mjs"]);
    assert.equal(okHealthWatch.ok, true, JSON.stringify(okHealthWatch));

    // The wrapper path itself is not an open door: sibling files in the same
    // directory stay rejected even when they exist inside the cwd.
    fs.writeFileSync(path.join(root, "deploy/launchd/targets/evil.mjs"), "// fixture\n");
    const existingSibling = planFor(root, [...baseArgs(root), "--", "deploy/launchd/targets/evil.mjs"]);
    assert.equal(existingSibling.code, "target_not_allowlisted");

    const unknownTarget = planFor(root, [...baseArgs(root), "--", "scripts/evil.mjs"]);
    assert.equal(unknownTarget.code, "target_not_allowlisted");

    const absoluteTarget = planFor(root, [...baseArgs(root), "--", path.join(root, "src/server.mjs")]);
    assert.equal(absoluteTarget.code, "target_must_be_relative");

    const escapingTarget = planFor(root, [...baseArgs(root), "--", "../elsewhere/src/server.mjs"]);
    assert.equal(escapingTarget.code, "target_escapes_cwd");

    const missingAllowExec = resolveRunnerPlan(
      ["--cwd", root, "--env-file", path.join(root, ".env.production"), "--", "src/server.mjs"],
      { runtimeVersion: PINNED_NODE_VERSION }
    );
    assert.equal(missingAllowExec.code, "allow_exec_required");

    const foreignExec = resolveRunnerPlan(
      ["--cwd", root, "--env-file", path.join(root, ".env.production"), "--allow-exec", "/usr/bin/false", "--", "src/server.mjs"],
      { runtimeVersion: PINNED_NODE_VERSION }
    );
    assert.equal(foreignExec.code, "exec_not_allowlisted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the runner executable fails closed end-to-end without leaking secret values", () => {
  const root = makeTempRepo({ envFileBody: "APP_SECRET_VALUE=1\n", envFileMode: 0o644 });
  try {
    let stderr = "";
    try {
      execFileSync(process.execPath, [
        "deploy/launchd/run-env-safe.mjs",
        "--cwd", root,
        "--env-file", path.join(root, ".env.production"),
        "--allow-exec", process.execPath,
        "--", "src/server.mjs",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.fail("runner should have exited non-zero");
    } catch (error) {
      stderr = String(error.stderr || "");
      assert.notEqual(error.status, 0);
    }
    // Fails closed with a structured reason (the exact code depends on the
    // interpreter: node_version_mismatch or env_file_mode_not_0600), and the
    // env values never reach stdout/stderr.
    assert.match(stderr, /"ok":false/);
    assert.doesNotMatch(stderr, /APP_SECRET_VALUE/);
    assert.doesNotMatch(stderr, /=1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the runner executes its main entry even when invoked through a symlinked path", () => {
  // Regression: ESM canonicalizes import.meta.url through symlinks (macOS
  // /var/folders -> /private/var/folders). The entry guard must compare
  // realpaths; otherwise main() is silently skipped and the runner exits 0
  // without launching or rejecting anything.
  const repoRoot = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const root = makeTempRepo({ envFileBody: "APP_ENV=production\n", envFileMode: 0o644 });
  try {
    // A self-contained copy of the runner inside the symlinked temp tree
    // reproduces the /var/folders -> /private/var/folders entry mismatch.
    fs.mkdirSync(path.dirname(path.join(root, "deploy", "launchd")), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "deploy", "launchd", "run-env-safe.mjs"),
      path.join(root, "deploy", "launchd", "run-env-safe.mjs")
    );
    const runnerCopy = path.join(root, "deploy", "launchd", "run-env-safe.mjs");
    let stderr = "";
    try {
      execFileSync(process.execPath, [
        runnerCopy,
        "--cwd", root,
        "--env-file", path.join(root, ".env.production"),
        "--allow-exec", process.execPath,
        "--", "src/server.mjs",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.fail("runner must not silently skip its main entry");
    } catch (error) {
      stderr = String(error.stderr || "");
      assert.notEqual(error.status, 0);
    }
    assert.match(stderr, /env_file_mode_not_0600/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
