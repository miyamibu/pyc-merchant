import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  REQUIRED_UI_VIEWPORT_WIDTHS,
  REQUIRED_UI_SOURCE_FILES,
  assertBrowserIdentityUnchanged,
  assertCiEvidenceManifest,
  assertEvidenceRunComplete,
  buildCiEvidenceDirName,
  buildUiViewportWidths,
  explicitBrowserSelection,
  extractCssBreakpointWidths,
  resolveEvidenceOutputDir,
  resolveEvidenceRunIdentity,
  verifyCiEvidenceDirectory,
} from "../scripts/ui-evidence-contract.mjs";
import { runUiEvidenceVerificationCli } from "../scripts/verify-ui-evidence.mjs";

const ROOT = process.cwd();

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function evidenceIdentity() {
  return {
    real_path: "/approved/browser",
    version_output: "Approved Browser 1.2.3",
    binary_size: 123,
    binary_mtime_ms: 456,
  };
}

function writeScreenshot(root, name) {
  const filePath = path.join(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "deterministic-screenshot-placeholder", "utf8");
  return path.relative(ROOT, filePath);
}

const CI_ENV = Object.freeze({
  GITHUB_RUN_ID: "1234567890",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_JOB: "ui-evidence",
  GITHUB_REPOSITORY: "example/jpyc-terminal",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "b".repeat(40),
});

const CI_EXPECTED = {
  source_commit: CI_ENV.GITHUB_SHA,
  run_id: CI_ENV.GITHUB_RUN_ID,
  run_attempt: CI_ENV.GITHUB_RUN_ATTEMPT,
  job: CI_ENV.GITHUB_JOB,
  now_ms: Date.parse("2026-08-22T00:10:00.000Z"),
};

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function ciEvidenceManifestFixture(overrides = {}) {
  const sha256 = "c".repeat(64);
  return {
    status: "passed",
    exit_code: 0,
    browser_started: true,
    run_started_at: "2026-08-22T00:00:00.000Z",
    generated_at: "2026-08-22T00:10:00.000Z",
    source_commit: CI_ENV.GITHUB_SHA,
    ci: {
      identity_source: "github_actions",
      run_id: CI_ENV.GITHUB_RUN_ID,
      run_attempt: CI_ENV.GITHUB_RUN_ATTEMPT,
      job: CI_ENV.GITHUB_JOB,
      repository: CI_ENV.GITHUB_REPOSITORY,
      ref: CI_ENV.GITHUB_REF,
      sha: CI_ENV.GITHUB_SHA,
    },
    source_sha256: { "public/app.css": sha256 },
    evidence_sha256: { "output/playwright/run-x/01-a.png": sha256 },
    ...overrides,
  };
}

test("明示ブラウザ実体がないrunは選択段階でfail-closedになる", () => {
  assert.throws(
    () => explicitBrowserSelection([], {}),
    (error) => error?.code === "BROWSER_SELECTION_REQUIRED",
  );
  assert.throws(
    () => explicitBrowserSelection(["--browser-executable", "relative/browser"], {}),
    (error) => error?.code === "BROWSER_PATH_NOT_ABSOLUTE",
  );
  assert.throws(
    () => explicitBrowserSelection(
      ["--browser-executable=/approved/browser-a"],
      { UI_EVIDENCE_BROWSER_EXECUTABLE: "/approved/browser-b" },
    ),
    (error) => error?.code === "BROWSER_SELECTION_CONFLICT",
  );
  assert.deepEqual(
    explicitBrowserSelection(["--browser-executable=/approved/browser"], {}),
    { executablePath: "/approved/browser", source: "cli" },
  );
});

test("必須幅とCSS breakpointの直前・境界・直後を決定的に列挙する", () => {
  const css = [
    "@media (max-width: 430px) { .a { display: block; } }",
    "@media (max-width: 760px) { .b { display: block; } }",
    "@media (min-width: 900px) and (max-width: 1160px) { .c { display: block; } }",
  ].join("\n");
  assert.deepEqual(
    extractCssBreakpointWidths(css),
    [429, 430, 431, 759, 760, 761, 899, 900, 901, 1159, 1160, 1161],
  );
  const widths = buildUiViewportWidths(css);
  for (const width of REQUIRED_UI_VIEWPORT_WIDTHS) {
    assert.ok(widths.includes(width), `required viewport ${width}px is missing`);
  }
  for (const width of [429, 431, 759, 760, 761, 899, 900, 901, 1159, 1160, 1161]) {
    assert.ok(widths.includes(width), `breakpoint evidence viewport ${width}px is missing`);
  }
});

test("browser未起動・幅欠落・画像欠落を成功証拠として受理しない", async () => {
  const baseDir = temporaryDirectory("ui-evidence-contract-incomplete");
  const identity = evidenceIdentity();
  await assert.rejects(
    assertEvidenceRunComplete({
      browserStarted: false,
      browserIdentity: identity,
      expectedWidths: [320],
      surfaces: ["terminal"],
      responsiveChecks: [],
      evidenceBaseDir: baseDir,
    }),
    (error) => error?.code === "EVIDENCE_BROWSER_NOT_STARTED",
  );
  await assert.rejects(
    assertEvidenceRunComplete({
      browserStarted: true,
      browserIdentity: identity,
      expectedWidths: [320],
      surfaces: ["terminal"],
      responsiveChecks: [],
      evidenceBaseDir: baseDir,
    }),
    (error) => error?.code === "EVIDENCE_MATRIX_INCOMPLETE",
  );
  await assert.rejects(
    assertEvidenceRunComplete({
      browserStarted: true,
      browserIdentity: identity,
      expectedWidths: [320],
      surfaces: ["terminal"],
      responsiveChecks: [{
        surface: "terminal",
        width: 320,
        status: "passed",
        screenshot: "missing.png",
        errors: [],
        overflow_px: 0,
      }],
      evidenceBaseDir: baseDir,
    }),
    (error) => error?.code === "EVIDENCE_SCREENSHOT_MISSING",
  );
});

test("全surface・全widthの一意な実在画像だけをcompleteと判定する", async () => {
  const baseDir = temporaryDirectory("ui-evidence-contract-complete");
  const expectedWidths = [320, 430];
  const surfaces = ["terminal", "mobile"];
  const responsiveChecks = [];
  for (const surface of surfaces) {
    for (const width of expectedWidths) {
      const screenshot = writeScreenshot(baseDir, `${surface}-${width}.png`);
      responsiveChecks.push({ surface, width, status: "passed", screenshot, errors: [], overflow_px: 0 });
    }
  }
  assert.equal(await assertEvidenceRunComplete({
    browserStarted: true,
    browserIdentity: evidenceIdentity(),
    expectedWidths,
    surfaces,
    responsiveChecks,
    evidenceBaseDir: ROOT,
  }), true);
});

test("row schema・横overflow・browser failureのいずれもcompleteへ昇格しない", async () => {
  const baseDir = temporaryDirectory("ui-evidence-contract-failures");
  const screenshot = writeScreenshot(baseDir, "terminal-320.png");
  const base = {
    browserStarted: true,
    browserIdentity: evidenceIdentity(),
    expectedWidths: [320],
    surfaces: ["terminal"],
    evidenceBaseDir: ROOT,
  };
  await assert.rejects(
    assertEvidenceRunComplete({
      ...base,
      responsiveChecks: [{ surface: "terminal", width: 320, status: "passed", screenshot, overflow_px: 0 }],
    }),
    (error) => error?.code === "EVIDENCE_ROW_SCHEMA_INVALID",
  );
  await assert.rejects(
    assertEvidenceRunComplete({
      ...base,
      responsiveChecks: [{ surface: "terminal", width: 320, status: "passed", screenshot, errors: [] }],
    }),
    (error) => error?.code === "EVIDENCE_OVERFLOW_MISSING",
  );
  await assert.rejects(
    assertEvidenceRunComplete({
      ...base,
      responsiveChecks: [
        { surface: "terminal", width: 320, status: "passed", screenshot, errors: [], overflow_px: 0 },
        { surface: "unexpected", width: 999, status: "passed", screenshot, errors: [], overflow_px: 0 },
      ],
    }),
    (error) => error?.code === "EVIDENCE_MATRIX_INCOMPLETE",
  );
  await assert.rejects(
    assertEvidenceRunComplete({
      ...base,
      responsiveChecks: [{ surface: "terminal", width: 320, status: "passed", screenshot, errors: [], overflow_px: 1 }],
    }),
    (error) => error?.code === "EVIDENCE_HORIZONTAL_OVERFLOW",
  );
  for (const browserFailure of [
    { consoleEvents: [{ type: "error", text: "boom" }] },
    { pageErrors: [{ message: "boom" }] },
    { httpFailures: [{ status: 500, path: "/boom" }] },
  ]) {
    await assert.rejects(
      assertEvidenceRunComplete({
        ...base,
        responsiveChecks: [{ surface: "terminal", width: 320, status: "passed", screenshot, errors: [], overflow_px: 0 }],
        ...browserFailure,
      }),
      (error) => error?.code === "EVIDENCE_BROWSER_FAILURES",
    );
  }
});

test("run中のbrowser identityまたは起動version差を拒否する", () => {
  const before = evidenceIdentity();
  assert.equal(assertBrowserIdentityUnchanged(before, { ...before }, "1.2.3"), true);
  assert.throws(
    () => assertBrowserIdentityUnchanged(before, { ...before, binary_size: 124 }, "1.2.3"),
    (error) => error?.code === "BROWSER_IDENTITY_CHANGED",
  );
  assert.throws(
    () => assertBrowserIdentityUnchanged(before, { ...before }, "9.9.9"),
    (error) => error?.code === "BROWSER_VERSION_MISMATCH",
  );
});

test("CI envからgithub_actions identityを解決し、CI値を捏造しないlocal identityを返す", () => {
  const identity = resolveEvidenceRunIdentity(CI_ENV);
  assert.equal(identity.identity_source, "github_actions");
  assert.equal(identity.run_id, "1234567890");
  assert.equal(identity.run_attempt, "2");
  assert.equal(identity.job, "ui-evidence");

  const local = resolveEvidenceRunIdentity({});
  assert.deepEqual(local, {
    identity_source: "local",
    run_id: null,
    run_attempt: null,
    job: null,
    repository: null,
    ref: null,
    sha: null,
  });
});

test("不完全なGitHub Actions envはidentityを捏造せずfail-closedになる", () => {
  for (const partial of [
    { GITHUB_RUN_ID: CI_ENV.GITHUB_RUN_ID },
    { GITHUB_RUN_ATTEMPT: CI_ENV.GITHUB_RUN_ATTEMPT },
    { GITHUB_JOB: CI_ENV.GITHUB_JOB },
    { GITHUB_RUN_ID: CI_ENV.GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT: CI_ENV.GITHUB_RUN_ATTEMPT },
    { GITHUB_RUN_ATTEMPT: CI_ENV.GITHUB_RUN_ATTEMPT, GITHUB_JOB: CI_ENV.GITHUB_JOB },
  ]) {
    assert.throws(
      () => resolveEvidenceRunIdentity(partial),
      (error) => error?.code === "EVIDENCE_CI_IDENTITY_INCOMPLETE",
      `expected fail-closed for ${JSON.stringify(partial)}`,
    );
  }
});

test("証拠出力先はCI run id/attempt/jobで決まり、明示overrideとlocal既定を維持する", () => {
  assert.equal(
    resolveEvidenceOutputDir({ root: ROOT, env: CI_ENV }),
    path.join(ROOT, "output", "playwright", `run-${CI_ENV.GITHUB_RUN_ID}-${CI_ENV.GITHUB_RUN_ATTEMPT}-${CI_ENV.GITHUB_JOB}`),
  );
  assert.equal(
    resolveEvidenceOutputDir({ root: ROOT, env: {}, fallbackStamp: "20260822T000000Z" }),
    path.join(ROOT, "output", "playwright", "story-ui-retest-20260822T000000Z"),
  );
  assert.equal(
    resolveEvidenceOutputDir({ root: ROOT, env: { ...CI_ENV, UI_EVIDENCE_OUTPUT_DIR: "/tmp/explicit-dir" } }),
    path.resolve(ROOT, "/tmp/explicit-dir"),
  );
  assert.equal(buildCiEvidenceDirName(resolveEvidenceRunIdentity(CI_ENV)), "run-1234567890-2-ui-evidence");
});

test("成功manifestはCI identity・source_commit・時刻・必須hashの照合に合格する", () => {
  assert.equal(assertCiEvidenceManifest(ciEvidenceManifestFixture(), CI_EXPECTED), true);
});

test("失敗manifest・identity不一致・空hashはCI照合に失敗する", () => {
  const mismatching = (overrides, expectedOverrides = {}) => {
    try {
      assertCiEvidenceManifest(ciEvidenceManifestFixture(overrides), { ...CI_EXPECTED, ...expectedOverrides });
    } catch (error) {
      return error;
    }
    return null;
  };
  for (const [label, overrides, expectedOverrides] of [
    ["status failed", { status: "failed" }, {}],
    ["browser未起動", { browser_started: false }, {}],
    ["local identity", { ci: { ...ciEvidenceManifestFixture().ci, identity_source: "local", run_id: null } }, {}],
    ["run_id不一致", {}, { run_id: "999" }],
    ["attempt不一致", {}, { run_attempt: "1" }],
    ["job不一致", {}, { job: "other-job" }],
    ["source_commit不一致", { source_commit: "a".repeat(40) }, {}],
    ["source_commit欠落", { source_commit: null }, {}],
    ["run_started_at欠落", { run_started_at: "" }, {}],
    ["generated_at不正", { generated_at: "not-a-date" }, {}],
    ["source hash空", { source_sha256: {} }, {}],
    ["evidence hash空", { evidence_sha256: {} }, {}],
    ["hash形式不正", { evidence_sha256: { "x.png": "zz" } }, {}],
    ["ci欄ごと欠落", { ci: undefined }, {}],
  ]) {
    const error = mismatching(overrides, expectedOverrides);
    assert.ok(error, `${label} should have failed`);
    assert.equal(error.code, "EVIDENCE_MANIFEST_CI_MISMATCH", label);
  }
});

test("時刻境界・ci.sha・expected.now_msの異常は対応するfailuresキーを1つだけ報告する", () => {
  const attempt = (overrides, expectedOverrides = {}) => {
    try {
      assertCiEvidenceManifest(ciEvidenceManifestFixture(overrides), { ...CI_EXPECTED, ...expectedOverrides });
    } catch (error) {
      return error;
    }
    return null;
  };
  for (const [label, overrides, expectedOverrides, failureKey] of [
    ["ci.sha不一致", { ci: { ...ciEvidenceManifestFixture().ci, sha: "a".repeat(40) } }, {}, "ci.sha"],
    ["generated_atが解析可能だが非正規形", { generated_at: "2026-08-22T00:10:00Z" }, {}, "generated_at"],
    ["generated_atがrun_started_atより前", {
      run_started_at: "2026-08-22T00:05:00.000Z",
      generated_at: "2026-08-22T00:00:00.000Z",
    }, {}, "generated_at_before_run_started_at"],
    ["run時間が30分超過", { run_started_at: "2026-08-21T23:35:00.000Z" }, {}, "run_duration_exceeded"],
    ["generated_atが想定nowより2分超先", {
      run_started_at: "2026-08-22T00:03:00.000Z",
      generated_at: "2026-08-22T00:13:00.000Z",
    }, {}, "generated_at_too_far_future"],
    ["generated_atが想定nowより10分超古い", {
      run_started_at: "2026-08-21T23:50:00.000Z",
      generated_at: "2026-08-21T23:55:00.000Z",
    }, {}, "generated_at_too_old"],
    ["expected.now_msが非有限", {}, { now_ms: Number.NaN }, "expected.now_ms"],
  ]) {
    const error = attempt(overrides, expectedOverrides);
    assert.ok(error, `${label} should have failed`);
    assert.equal(error.code, "EVIDENCE_MANIFEST_CI_MISMATCH", label);
    assert.deepEqual(error.failures, [failureKey], label);
  }
});

for (const script of ["scripts/story-ui-retest.mjs", "scripts/record-real-ui-operation-videos.mjs"]) {
  test(`${script} はブラウザ未指定時にfailed manifestと非0終了を残し、ブラウザを起動しない`, () => {
    const outputDir = temporaryDirectory(path.basename(script, ".mjs"));
    const env = { ...process.env, UI_EVIDENCE_OUTPUT_DIR: outputDir };
    delete env.UI_EVIDENCE_BROWSER_EXECUTABLE;
    const result = spawnSync(process.execPath, [path.join(ROOT, script)], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 1, `${script} unexpectedly succeeded:\n${result.stdout}\n${result.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.exit_code, 1);
    assert.equal(manifest.browser_started, false);
    assert.equal(manifest.failure_mode, "explicit_browser_selection_required");
    assert.deepEqual(manifest.responsive_checks, []);
    if (script.endsWith("story-ui-retest.mjs")) {
      assert.equal(typeof manifest.run_started_at, "string");
      assert.ok(manifest.run_started_at.length > 0);
      assert.ok(
        manifest.source_commit === null || /^[a-f0-9]{40}$/.test(manifest.source_commit),
        `unexpected source_commit: ${manifest.source_commit}`,
      );
      if (manifest.ci !== null) {
        assert.ok(["local", "github_actions"].includes(manifest.ci.identity_source));
      }
    }
    assert.equal(fs.readFileSync(path.join(outputDir, "exit-code.txt"), "utf8"), "1\n");
    assert.match(result.stderr, /ブラウザは未選択です/);
  });
}

test("証拠スクリプトは共通fail-closed契約を使い、旧二重PIN・静的Playwright・DB直書きを含まない", () => {
  const story = fs.readFileSync(path.join(ROOT, "scripts/story-ui-retest.mjs"), "utf8");
  const videos = fs.readFileSync(path.join(ROOT, "scripts/record-real-ui-operation-videos.mjs"), "utf8");
  for (const source of [story, videos]) {
    assert.match(source, /explicitBrowserSelection\(/);
    assert.match(source, /captureBrowserBinaryIdentity\(/);
    assert.match(source, /assertBrowserIdentityUnchanged\(/);
    assert.match(source, /await assertEvidenceRunComplete\(/);
    assert.match(source, /page\.on\("requestfailed"/);
    assert.match(source, /\["error", "warning", "assert"\]/);
    assert.match(source, /consoleEvents,/);
    assert.match(source, /pageErrors,/);
    assert.match(source, /httpFailures,/);
    assert.match(source, /executablePath:\s*browserSelection\.executablePath/);
    assert.doesNotMatch(source, /staffPinConfirm/);
    assert.doesNotMatch(source, /import\s*\{\s*chromium\s*\}\s*from\s*["']playwright["']/);
  }
  assert.doesNotMatch(videos, /better-sqlite3|new Database|\b(?:UPDATE|DELETE|INSERT)\s+[a-z_]/i);
  assert.doesNotMatch(videos, /homedir\(\)[\s\S]{0,80}["']Desktop["']/);
});

test("verify-ui-evidence.mjs CLI: インポート副作用なし", async () => {
  const { runUiEvidenceVerificationCli } = await import("../scripts/verify-ui-evidence.mjs");
  assert.ok(typeof runUiEvidenceVerificationCli === "function");
});

test("verify-ui-evidence.mjs CLI: positive --evidence-dir VALUE 形式", async () => {
  const nowMs = Date.now();
  const fixture = createSyntheticFixture(nowMs);
  const mockVerifier = async (options) => {
    return verifyCiEvidenceDirectory({ ...options, nowMs });
  };
  let stdout = "";
  let stderr = "";
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: ["--evidence-dir", fixture.evidenceDir],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: mockVerifier,
    nowMs,
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const output = JSON.parse(stdout.trim());
  assert.equal(output.ok, true);
  assert.equal(output.status, "passed");
  assert.equal(output.evidence_directory, fixture.evidenceDir);
  assert.equal(output.relative_evidence_directory, `output/playwright/${fixture.evidenceDirName}`);
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test("verify-ui-evidence.mjs CLI: positive --evidence-dir=VALUE 形式", async () => {
  const nowMs = Date.now();
  const fixture = createSyntheticFixture(nowMs);
  const mockVerifier = async (options) => {
    return verifyCiEvidenceDirectory({ ...options, nowMs });
  };
  let stdout = "";
  let stderr = "";
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: [`--evidence-dir=${fixture.evidenceDir}`],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: mockVerifier,
    nowMs,
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const output = JSON.parse(stdout.trim());
  assert.equal(output.ok, true);
  assert.equal(output.status, "passed");
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

function createSyntheticFixture(timestamp = new Date(Date.now() - 60000).toISOString()) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ci-evidence-"));
  const evidenceDirName = `run-${CI_ENV.GITHUB_RUN_ID}-${CI_ENV.GITHUB_RUN_ATTEMPT}-${CI_ENV.GITHUB_JOB}`;
  const evidenceDir = path.join(fixtureRoot, "output", "playwright", evidenceDirName);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const sourceFiles = {};
  for (const relPath of REQUIRED_UI_SOURCE_FILES) {
    const fullPath = path.join(fixtureRoot, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const content = `synthetic-${relPath}-content`;
    fs.writeFileSync(fullPath, content, "utf8");
    sourceFiles[relPath] = sha256Hex(content);
  }

  const cssText = fs.readFileSync(path.join(fixtureRoot, "public/app.css"), "utf8");
  const recomputedWidths = buildUiViewportWidths(cssText);
  const surfaces = ["mobile", "terminal"];

  const evidenceEntries = [];
  const evidenceHashes = {};
  const responsiveChecks = [];

  for (const surface of surfaces) {
    for (const width of recomputedWidths) {
      const relPath = `output/playwright/${evidenceDirName}/${surface}-${width}.png`;
      const fullPath = path.join(fixtureRoot, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `screenshot-${surface}-${width}`, "utf8");
      const hash = sha256Hex(`screenshot-${surface}-${width}`);
      evidenceEntries.push({ name: `${surface}-${width}`, path: relPath });
      evidenceHashes[relPath] = hash;
      responsiveChecks.push({
        surface,
        width,
        status: "passed",
        screenshot: relPath,
        errors: [],
        overflow_px: 0,
      });
    }
  }

  const now = Date.now();
  const runStartedAt = new Date(now - 30000).toISOString();
  const generatedAt = new Date(now - 10000).toISOString();
  const manifest = {
    status: "passed",
    exit_code: 0,
    browser_started: true,
    run_started_at: runStartedAt,
    generated_at: generatedAt,
    source_commit: CI_ENV.GITHUB_SHA,
    output_dir: `output/playwright/${evidenceDirName}`,
    ci: {
      identity_source: "github_actions",
      run_id: CI_ENV.GITHUB_RUN_ID,
      run_attempt: CI_ENV.GITHUB_RUN_ATTEMPT,
      job: CI_ENV.GITHUB_JOB,
      repository: CI_ENV.GITHUB_REPOSITORY,
      ref: CI_ENV.GITHUB_REF,
      sha: CI_ENV.GITHUB_SHA,
    },
    source_sha256: sourceFiles,
    evidence_sha256: evidenceHashes,
    evidence: evidenceEntries,
    responsive_widths: recomputedWidths,
    responsive_checks: responsiveChecks,
    runtime: { responsive_widths: recomputedWidths },
    browser_identity: {
      selection_source: "cli",
      requested_path: "/approved/browser",
      real_path: "/approved/browser",
      version_output: "Approved Browser 1.2.3",
      binary_size: 123,
      binary_mtime_ms: 456,
    },
    console_events: [],
    page_errors: [],
    http_failures: [],
  };

  const verifyScriptContent = "// synthetic verify-ui-evidence.mjs";
  const verifyScriptPath = path.join(fixtureRoot, "scripts/verify-ui-evidence.mjs");
  fs.mkdirSync(path.dirname(verifyScriptPath), { recursive: true });
  fs.writeFileSync(verifyScriptPath, verifyScriptContent, "utf8");
  sourceFiles["scripts/verify-ui-evidence.mjs"] = sha256Hex(verifyScriptContent);

  fs.writeFileSync(path.join(evidenceDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(evidenceDir, "exit-code.txt"), "0\n", "utf8");

  return { fixtureRoot, evidenceDir, evidenceDirName, manifest, recomputedWidths, sourceFiles };
}

function parseSingleLineJsonStderr(stderrText) {
  assert.ok(stderrText.endsWith("\n"), "stderr must end with a newline");
  assert.ok(!stderrText.endsWith("\n\n"), "stderr must end with exactly one newline");
  const content = stderrText.slice(0, -1);
  assert.ok(content.length > 0, "stderr must be non-empty before the final newline");
  assert.ok(!content.includes("\n"), "stderr must contain no newline before the final newline");
  return JSON.parse(content);
}

test("verify-ui-evidence.mjs CLI: unknown引数でverifier未呼出・fail-closed", async () => {
  const fixture = createSyntheticFixture();
  let verifierCalled = false;
  let stdout = "";
  let stderr = "";
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: ["--unknown-flag"],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: async () => { verifierCalled = true; },
  });
  assert.equal(exitCode, 1);
  assert.equal(verifierCalled, false);
  assert.equal(stdout, "");
  const output = parseSingleLineJsonStderr(stderr);
  assert.equal(output.ok, false);
  assert.equal(output.code, "UNKNOWN_ARGUMENT");
  assert.ok(output.message.includes("未知の引数"));
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test("verify-ui-evidence.mjs CLI: 重複--evidence-dirでverifier未呼出・fail-closed", async () => {
  const fixture = createSyntheticFixture();
  let verifierCalled = false;
  let stdout = "";
  let stderr = "";
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: ["--evidence-dir", fixture.evidenceDir, "--evidence-dir", fixture.evidenceDir],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: async () => { verifierCalled = true; },
  });
  assert.equal(exitCode, 1);
  assert.equal(verifierCalled, false);
  assert.equal(stdout, "");
  const output = parseSingleLineJsonStderr(stderr);
  assert.equal(output.ok, false);
  assert.equal(output.code, "DUPLICATE_EVIDENCE_DIR_FLAG");
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test("verify-ui-evidence.mjs CLI: --evidence-dir値欠落でverifier未呼出・fail-closed", async () => {
  const fixture = createSyntheticFixture();
  let verifierCalled = false;
  let stdout = "";
  let stderr = "";
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: ["--evidence-dir"],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: async () => { verifierCalled = true; },
  });
  assert.equal(exitCode, 1);
  assert.equal(verifierCalled, false);
  assert.equal(stdout, "");
  const output = parseSingleLineJsonStderr(stderr);
  assert.equal(output.ok, false);
  assert.equal(output.code, "MISSING_EVIDENCE_DIR_VALUE");
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test("verify-ui-evidence.mjs CLI: --evidence-dir=空値でverifier未呼出・fail-closed", async () => {
  const fixture = createSyntheticFixture();
  let verifierCalled = false;
  let stdout = "";
  let stderr = "";
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: ["--evidence-dir="],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: async () => { verifierCalled = true; },
  });
  assert.equal(exitCode, 1);
  assert.equal(verifierCalled, false);
  assert.equal(stdout, "");
  const output = parseSingleLineJsonStderr(stderr);
  assert.equal(output.ok, false);
  assert.equal(output.code, "EMPTY_EVIDENCE_DIR_VALUE");
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test("verify-ui-evidence.mjs CLI: argv空でverifier未呼出・fail-closed", async () => {
  const fixture = createSyntheticFixture();
  let verifierCalled = false;
  let stdout = "";
  let stderr = "";
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: [],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: async () => { verifierCalled = true; },
  });
  assert.equal(exitCode, 1);
  assert.equal(verifierCalled, false);
  assert.equal(stdout, "");
  const output = parseSingleLineJsonStderr(stderr);
  assert.equal(output.ok, false);
  assert.equal(output.code, "MISSING_EVIDENCE_DIR_FLAG");
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test("verify-ui-evidence.mjs CLI: 位置引数でverifier未呼出・fail-closed", async () => {
  const fixture = createSyntheticFixture();
  let verifierCalled = false;
  let stdout = "";
  let stderr = "";
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: ["positional-arg"],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: async () => { verifierCalled = true; },
  });
  assert.equal(exitCode, 1);
  assert.equal(verifierCalled, false);
  assert.equal(stdout, "");
  const output = parseSingleLineJsonStderr(stderr);
  assert.equal(output.ok, false);
  assert.equal(output.code, "UNKNOWN_ARGUMENT");
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test("verify-ui-evidence.mjs CLI: verifierエラーをsanitizeして単行stderr JSONで返す", async () => {
  const fixture = createSyntheticFixture();
  let stdout = "";
  let stderr = "";
  const verifierError = new Error("multi\nline\ttab\r\ncontrol\u0000chars");
  verifierError.code = "TEST_ERROR_CODE";
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: ["--evidence-dir", fixture.evidenceDir],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: async () => { throw verifierError; },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  const output = JSON.parse(stderr.trim());
  assert.equal(output.ok, false);
  assert.equal(output.code, "TEST_ERROR_CODE");
  assert.ok(!output.message.includes("\n"));
  assert.ok(!output.message.includes("\r"));
  assert.ok(!output.message.includes("\t"));
  assert.ok(!output.message.includes("\u0000"));
  assert.ok(output.message.length <= 1024);
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test("verify-ui-evidence.mjs CLI: verifierエラーcode無しは正規化fallback", async () => {
  const fixture = createSyntheticFixture();
  let stdout = "";
  let stderr = "";
  const verifierError = new Error("no code error");
  delete verifierError.code;
  const exitCode = await runUiEvidenceVerificationCli({
    root: fixture.fixtureRoot,
    env: CI_ENV,
    argv: ["--evidence-dir", fixture.evidenceDir],
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    verifier: async () => { throw verifierError; },
  });
  assert.equal(exitCode, 1);
  const output = JSON.parse(stderr.trim());
  assert.equal(output.ok, false);
  assert.equal(output.code, "UI_EVIDENCE_VERIFY_FAILED");
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test("verifyCiEvidenceDirectory positive: frozen success summary with expected paths and passed manifest", async () => {
  const nowMs = Date.now();
  const { fixtureRoot, evidenceDir, evidenceDirName, manifest, recomputedWidths } = createSyntheticFixture();
  try {
    const result = await verifyCiEvidenceDirectory({ root: fixtureRoot, env: CI_ENV, nowMs });
    assert.ok(Object.isFrozen(result));
    assert.equal(result.evidenceDirectory, evidenceDir);
    assert.equal(result.relativeEvidenceDirectory, `output/playwright/${evidenceDirName}`);
    assert.deepEqual(result.manifest, manifest);
    assert.deepEqual(result.manifest.responsive_widths, recomputedWidths);
    assert.deepEqual(result.manifest.runtime.responsive_widths, recomputedWidths);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

const NEGATIVE_CASES = [
  {
    name: "exit-code bytes not exactly 0 newline",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      fs.writeFileSync(path.join(fixtureRoot, "output", "playwright", evidenceDirName, "exit-code.txt"), "0", "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_EXIT_CODE_INVALID",
  },
  {
    name: "manifest exit_code nonzero",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.exit_code = 1;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_EXIT_CODE_NOT_ZERO",
  },
  {
    name: "output_dir mismatch",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.output_dir = "output/playwright/wrong-dir";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_OUTPUT_DIR_MISMATCH",
  },
  {
    name: "missing and extra source hash key",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      delete manifest.source_sha256["public/app.css"];
      manifest.source_sha256["extra/file.txt"] = "d".repeat(64);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_SOURCE_SHA256_KEYS_MISMATCH",
  },
  {
    name: "source file bytes tampered after hash",
    mutate: ({ fixtureRoot }) => {
      fs.writeFileSync(path.join(fixtureRoot, "public/app.css"), "tampered-content", "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_SOURCE_SHA256_MISMATCH",
  },
  {
    name: "evidence file bytes tampered after hash",
    mutate: ({ fixtureRoot, evidenceDirName, manifest }) => {
      const entry = manifest.evidence[0];
      fs.writeFileSync(path.join(fixtureRoot, entry.path), "tampered-screenshot", "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_EVIDENCE_SHA256_MISMATCH",
  },
  {
    name: "canonical traversal/backslash/absolute evidence path rejected",
    mutate: ({ fixtureRoot, evidenceDirName, manifest }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const entry = manifest.evidence[0];
      entry.path = entry.path.replace("mobile-320.png", "../escape.png");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_EVIDENCE_PATH_INVALID",
  },
  {
    name: "root-relative path outside deterministic dir rejected even with matching key/hash",
    mutate: ({ fixtureRoot, evidenceDirName, manifest }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const outsidePath = "output/playwright/outside/evil.png";
      const outsideFull = path.join(fixtureRoot, outsidePath);
      fs.mkdirSync(path.dirname(outsideFull), { recursive: true });
      fs.writeFileSync(outsideFull, "outside-screenshot", "utf8");
      const hash = sha256Hex("outside-screenshot");
      manifest.evidence[0].path = outsidePath;
      manifest.evidence_sha256[outsidePath] = hash;
      delete manifest.evidence_sha256[manifest.evidence[1].path];
      manifest.evidence.splice(1, 1);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_EVIDENCE_PATH_OUTSIDE",
  },
  {
    name: "duplicate evidence name",
    mutate: ({ fixtureRoot, evidenceDirName, manifest }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      manifest.evidence[1].name = manifest.evidence[0].name;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_EVIDENCE_NAME_DUPLICATE",
  },
  {
    name: "duplicate evidence path",
    mutate: ({ fixtureRoot, evidenceDirName, manifest }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      manifest.evidence[1].path = manifest.evidence[0].path;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_EVIDENCE_PATH_DUPLICATE",
  },
  {
    name: "evidence hash missing/extra key",
    mutate: ({ fixtureRoot, evidenceDirName, manifest }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      delete manifest.evidence_sha256[manifest.evidence[0].path];
      manifest.evidence_sha256["extra/missing.png"] = "e".repeat(64);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_EVIDENCE_SHA256_KEYS_MISMATCH",
  },
  {
    name: "evidence file replaced by symlink",
    mutate: ({ fixtureRoot, evidenceDirName, manifest }) => {
      const entry = manifest.evidence[0];
      const fullPath = path.join(fixtureRoot, entry.path);
      fs.unlinkSync(fullPath);
      fs.symlinkSync("/etc/passwd", fullPath);
    },
    expectedCode: "EVIDENCE_FS_SYMLINK_REJECTED",
  },
  {
    name: "manifest.json replaced by symlink",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      fs.unlinkSync(manifestPath);
      fs.symlinkSync("/etc/passwd", manifestPath);
    },
    expectedCode: "EVIDENCE_FS_SYMLINK_REJECTED",
  },
  {
    name: "unbound extra file",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      fs.writeFileSync(path.join(fixtureRoot, "output", "playwright", evidenceDirName, "unbound.txt"), "extra", "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_EXTRA_FILE",
  },
  {
    name: "unbound empty directory",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      fs.mkdirSync(path.join(fixtureRoot, "output", "playwright", evidenceDirName, "empty-dir"), { recursive: true });
    },
    expectedCode: "EVIDENCE_VERIFY_EXTRA_DIRECTORY",
  },
  {
    name: "responsive widths missing/reordered in top-level",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.responsive_widths = manifest.responsive_widths.slice(1);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_RESPONSIVE_WIDTHS_MISMATCH",
  },
  {
    name: "responsive widths missing/reordered in runtime",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.runtime.responsive_widths = manifest.runtime.responsive_widths.slice(1);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_RESPONSIVE_WIDTHS_MISMATCH",
  },
  {
    name: "responsive screenshot unbound",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.responsive_checks[0].screenshot = "output/playwright/unbound.png";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_SCREENSHOT_UNBOUND",
  },
  {
    name: "duplicate responsive screenshot binding",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.responsive_checks[1].screenshot = manifest.responsive_checks[0].screenshot;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_VERIFY_SCREENSHOT_UNBOUND",
  },
  {
    name: "horizontal overflow still rejected by matrix verifier",
    mutate: ({ fixtureRoot, evidenceDirName }) => {
      const manifestPath = path.join(fixtureRoot, "output", "playwright", evidenceDirName, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.responsive_checks[0].overflow_px = 5;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    },
    expectedCode: "EVIDENCE_HORIZONTAL_OVERFLOW",
  },
];

for (const tc of NEGATIVE_CASES) {
  test(`verifyCiEvidenceDirectory negative: ${tc.name}`, async () => {
    const nowMs = Date.now();
    const fixture = createSyntheticFixture();
    try {
      tc.mutate(fixture);
      await assert.rejects(
        verifyCiEvidenceDirectory({ root: fixture.fixtureRoot, env: CI_ENV, nowMs }),
        (error) => error?.code === tc.expectedCode,
        `expected ${tc.expectedCode}`
      );
    } finally {
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
}
