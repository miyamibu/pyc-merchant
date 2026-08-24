import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CI_EVIDENCE_DIR_PREFIX = "run";

export const REQUIRED_UI_SOURCE_FILES = Object.freeze([
  "public/app.css",
  "public/mobile.html",
  "public/mobile.js",
  "public/terminal-entry.html",
  "public/terminal-entry.js",
  "public/terminal.html",
  "public/terminal.js",
  "src/server.mjs",
  "scripts/story-ui-retest.mjs",
  "scripts/ui-evidence-contract.mjs",
  "scripts/verify-ui-evidence.mjs",
  "tests/helpers/server-process.mjs",
]);

const EVIDENCE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CI_POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const GIT_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function sanitizeEvidencePathSegment(value) {
  const cleaned = String(value ?? "").trim();
  if (!EVIDENCE_PATH_SEGMENT_PATTERN.test(cleaned)) {
    const error = new Error(`証拠path segmentとして使えない値です: ${JSON.stringify(String(value ?? ""))}`);
    error.code = "EVIDENCE_PATH_SEGMENT_INVALID";
    throw error;
  }
  return cleaned;
}

export function resolveEvidenceRunIdentity(env = {}) {
  const runId = String(env.GITHUB_RUN_ID || "").trim();
  const runAttempt = String(env.GITHUB_RUN_ATTEMPT || "").trim();
  const jobName = String(env.GITHUB_JOB || "").trim();
  const sha = String(env.GITHUB_SHA || "").trim();
  if (!runId && !runAttempt && !jobName && !sha) {
    return Object.freeze({
      identity_source: "local",
      run_id: null,
      run_attempt: null,
      job: null,
      repository: String(env.GITHUB_REPOSITORY || "").trim() || null,
      ref: String(env.GITHUB_REF || "").trim() || null,
      sha: null,
    });
  }
  if (!runId || !runAttempt || !jobName || !sha) {
    const error = new Error(
      "GitHub Actionsの実行identityが不完全です（GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT/GITHUB_JOB/GITHUB_SHAが必須）。CI identityを捏造せずfail-closedします。"
    );
    error.code = "EVIDENCE_CI_IDENTITY_INCOMPLETE";
    throw error;
  }
  if (
    !CI_POSITIVE_INTEGER_PATTERN.test(runId)
    || !CI_POSITIVE_INTEGER_PATTERN.test(runAttempt)
    || !EVIDENCE_PATH_SEGMENT_PATTERN.test(jobName)
    || !GIT_COMMIT_SHA_PATTERN.test(sha)
  ) {
    const error = new Error(
      "GitHub Actionsの実行identityの形式が不正です（runId/runAttemptは整数、jobは[A-Za-z0-9._-]セグメント、shaは40桁hex必須）。危険値を置換せずfail-closedします。"
    );
    error.code = "EVIDENCE_CI_IDENTITY_INVALID";
    throw error;
  }
  return Object.freeze({
    identity_source: "github_actions",
    run_id: runId,
    run_attempt: runAttempt,
    job: jobName,
    repository: String(env.GITHUB_REPOSITORY || "").trim() || null,
    ref: String(env.GITHUB_REF || "").trim() || null,
    sha,
  });
}

export function buildCiEvidenceDirName(identity) {
  if (identity?.identity_source !== "github_actions") {
    const error = new Error("github_actions identity以外からCI証拠directory名は作れません。");
    error.code = "EVIDENCE_CI_IDENTITY_REQUIRED";
    throw error;
  }
  return [
    CI_EVIDENCE_DIR_PREFIX,
    sanitizeEvidencePathSegment(identity.run_id),
    sanitizeEvidencePathSegment(identity.run_attempt),
    sanitizeEvidencePathSegment(identity.job),
  ].join("-");
}

export function resolveEvidenceOutputDir({ root, env = {}, fallbackStamp } = {}) {
  const explicit = String(env.UI_EVIDENCE_OUTPUT_DIR || "").trim();
  if (explicit) {
    return path.resolve(root, explicit);
  }
  const identity = resolveEvidenceRunIdentity(env);
  if (identity.identity_source === "github_actions") {
    return path.resolve(root, "output", "playwright", buildCiEvidenceDirName(identity));
  }
  const stamp = fallbackStamp
    || new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.resolve(root, "output", "playwright", `story-ui-retest-${stamp}`);
}

export function resolveSourceCommit(root) {
  try {
    const stdout = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const commit = String(stdout || "").trim();
    return /^[a-f0-9]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

export const REQUIRED_UI_VIEWPORT_WIDTHS = Object.freeze([
  320,
  360,
  375,
  390,
  412,
  430,
  768,
  1024,
  1280,
  1440,
  1920,
  2560,
]);

export function explicitBrowserSelection(argv = [], env = {}) {
  let cliPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--browser-executable") {
      cliPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (argument.startsWith("--browser-executable=")) {
      cliPath = argument.slice("--browser-executable=".length).trim();
    }
  }
  const envPath = String(env.UI_EVIDENCE_BROWSER_EXECUTABLE || "").trim();
  if (cliPath && envPath && path.resolve(cliPath) !== path.resolve(envPath)) {
    const error = new Error("CLIと環境変数で異なるブラウザ実体が指定されています。1つに統一してください。");
    error.code = "BROWSER_SELECTION_CONFLICT";
    throw error;
  }
  const executablePath = cliPath || envPath;
  if (!executablePath) {
    const error = new Error(
      "ブラウザは未選択です。承認済みブラウザの絶対パスを --browser-executable で明示してください。"
    );
    error.code = "BROWSER_SELECTION_REQUIRED";
    throw error;
  }
  if (!path.isAbsolute(executablePath)) {
    const error = new Error("--browser-executable には承認済みブラウザの絶対パスが必要です。");
    error.code = "BROWSER_PATH_NOT_ABSOLUTE";
    throw error;
  }
  return Object.freeze({
    executablePath: path.normalize(executablePath),
    source: cliPath ? "cli" : "environment",
  });
}

export function extractCssBreakpointWidths(cssText, { minWidth = 320, maxWidth = 2560 } = {}) {
  const boundaries = new Set();
  const mediaPattern = /@media\s*([^\{]+)\{/g;
  for (const mediaMatch of String(cssText || "").matchAll(mediaPattern)) {
    const condition = mediaMatch[1];
    for (const widthMatch of condition.matchAll(/\((?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\)/g)) {
      const boundary = Number(widthMatch[1]);
      if (!Number.isInteger(boundary)) continue;
      for (const candidate of [boundary - 1, boundary, boundary + 1]) {
        if (candidate >= minWidth && candidate <= maxWidth) boundaries.add(candidate);
      }
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}

export function buildUiViewportWidths(cssText, options = {}) {
  const minWidth = Number(options.minWidth ?? 320);
  const maxWidth = Number(options.maxWidth ?? 2560);
  const widths = new Set(
    REQUIRED_UI_VIEWPORT_WIDTHS.filter((width) => width >= minWidth && width <= maxWidth)
  );
  for (const width of extractCssBreakpointWidths(cssText, { minWidth, maxWidth })) widths.add(width);
  return [...widths].sort((left, right) => left - right);
}

export async function captureBrowserBinaryIdentity(selection) {
  const executablePath = String(selection?.executablePath || "");
  if (!executablePath) throw new Error("browser executable path is required");
  await fs.access(executablePath, fsConstants.X_OK);
  const realPath = await fs.realpath(executablePath);
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    const error = new Error(`指定されたブラウザ実体はファイルではありません: ${realPath}`);
    error.code = "BROWSER_EXECUTABLE_INVALID";
    throw error;
  }
  const { stdout, stderr } = await execFileAsync(realPath, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const versionOutput = String(stdout || stderr || "").trim();
  if (!versionOutput) {
    const error = new Error("指定ブラウザからversion情報を取得できませんでした。");
    error.code = "BROWSER_VERSION_UNAVAILABLE";
    throw error;
  }
  return Object.freeze({
    selection_source: String(selection.source || "unknown"),
    requested_path: executablePath,
    real_path: realPath,
    version_output: versionOutput,
    binary_size: stat.size,
    binary_mtime_ms: Math.trunc(stat.mtimeMs),
  });
}

export async function assertEvidenceRunComplete({
  browserStarted,
  browserIdentity,
  expectedWidths,
  surfaces,
  responsiveChecks,
  evidenceBaseDir,
  consoleEvents = [],
  pageErrors = [],
  httpFailures = [],
} = {}) {
  if (browserStarted !== true) {
    const error = new Error("ブラウザ未起動のrunを成功証拠として確定できません。");
    error.code = "EVIDENCE_BROWSER_NOT_STARTED";
    throw error;
  }
  if (!browserIdentity?.real_path || !browserIdentity?.version_output) {
    const error = new Error("ブラウザidentity/versionが固定されていません。");
    error.code = "EVIDENCE_BROWSER_IDENTITY_MISSING";
    throw error;
  }
  const widths = [...new Set((expectedWidths || []).map(Number).filter(Number.isInteger))];
  const requiredSurfaces = [...new Set((surfaces || []).map(String).filter(Boolean))];
  const checks = Array.isArray(responsiveChecks) ? responsiveChecks : [];
  if (widths.length === 0 || requiredSurfaces.length === 0) {
    const error = new Error("証拠runの対象width/surfaceが空です。");
    error.code = "EVIDENCE_MATRIX_EMPTY";
    throw error;
  }
  if (!String(evidenceBaseDir || "").trim()) {
    const error = new Error("スクリーンショットを検証する基準ディレクトリがありません。");
    error.code = "EVIDENCE_BASE_DIR_MISSING";
    throw error;
  }
  if (checks.length !== widths.length * requiredSurfaces.length) {
    const error = new Error("証拠行数が必須surface/width行列と一致しません。");
    error.code = "EVIDENCE_MATRIX_INCOMPLETE";
    throw error;
  }
  const screenshotPaths = new Set();
  for (const surface of requiredSurfaces) {
    for (const width of widths) {
      const matches = checks.filter((row) => row?.surface === surface && Number(row?.width) === width);
      if (matches.length !== 1) {
        const error = new Error(`${surface} ${width}px の証拠行が一意ではありません。`);
        error.code = "EVIDENCE_MATRIX_INCOMPLETE";
        throw error;
      }
      const row = matches[0];
      if (
        !Object.prototype.hasOwnProperty.call(row, "status")
        || !Object.prototype.hasOwnProperty.call(row, "screenshot")
        || !Array.isArray(row.errors)
      ) {
        const error = new Error(`${surface} ${width}px の証拠行にstatus/screenshot/errorsが揃っていません。`);
        error.code = "EVIDENCE_ROW_SCHEMA_INVALID";
        throw error;
      }
      if (typeof row.overflow_px !== "number" || !Number.isFinite(row.overflow_px)) {
        const error = new Error(`${surface} ${width}px の横overflow実測値がありません。`);
        error.code = "EVIDENCE_OVERFLOW_MISSING";
        throw error;
      }
      if (row.overflow_px > 0) {
        const error = new Error(`${surface} ${width}px で横overflowを検出しました: ${row.overflow_px}px`);
        error.code = "EVIDENCE_HORIZONTAL_OVERFLOW";
        throw error;
      }
      const errors = row.errors.filter(Boolean);
      if (row.status !== "passed" || !String(row.screenshot || "").trim() || errors.length > 0) {
        const error = new Error(`${surface} ${width}px の描画証拠が合格条件を満たしていません。`);
        error.code = "EVIDENCE_WIDTH_FAILED";
        throw error;
      }
      const screenshotPath = path.isAbsolute(row.screenshot)
        ? path.normalize(row.screenshot)
        : path.resolve(evidenceBaseDir, row.screenshot);
      if (screenshotPaths.has(screenshotPath)) {
        const error = new Error(`${surface} ${width}px のスクリーンショットが別の証拠行と重複しています。`);
        error.code = "EVIDENCE_SCREENSHOT_DUPLICATE";
        throw error;
      }
      screenshotPaths.add(screenshotPath);
      let screenshotStat;
      try {
        screenshotStat = await fs.stat(screenshotPath);
      } catch {
        const error = new Error(`${surface} ${width}px のスクリーンショット実体がありません。`);
        error.code = "EVIDENCE_SCREENSHOT_MISSING";
        throw error;
      }
      if (!screenshotStat.isFile() || screenshotStat.size <= 0) {
        const error = new Error(`${surface} ${width}px のスクリーンショット実体が空または不正です。`);
        error.code = "EVIDENCE_SCREENSHOT_INVALID";
        throw error;
      }
    }
  }
  const fatalConsoleEvents = (Array.isArray(consoleEvents) ? consoleEvents : [])
    .filter((event) => ["error", "assert"].includes(String(event?.type || "").toLowerCase()));
  const normalizedPageErrors = Array.isArray(pageErrors) ? pageErrors.filter(Boolean) : [];
  const normalizedHttpFailures = Array.isArray(httpFailures) ? httpFailures.filter(Boolean) : [];
  if (fatalConsoleEvents.length > 0 || normalizedPageErrors.length > 0 || normalizedHttpFailures.length > 0) {
    const error = new Error(
      `ブラウザ失敗を検出しました: console=${fatalConsoleEvents.length} page=${normalizedPageErrors.length} http=${normalizedHttpFailures.length}`
    );
    error.code = "EVIDENCE_BROWSER_FAILURES";
    throw error;
  }
  return true;
}

export function assertBrowserIdentityUnchanged(before, after, launchedVersion) {
  for (const field of ["real_path", "version_output", "binary_size", "binary_mtime_ms"]) {
    if (before?.[field] !== after?.[field]) {
      const error = new Error(`run中にブラウザidentityが変化しました: ${field}`);
      error.code = "BROWSER_IDENTITY_CHANGED";
      throw error;
    }
  }
  const normalizedLaunchVersion = String(launchedVersion || "").trim();
  if (!normalizedLaunchVersion || !String(before.version_output).includes(normalizedLaunchVersion)) {
    const error = new Error(
      `起動ブラウザversionと指定実体が一致しません: binary=${before.version_output}, launched=${normalizedLaunchVersion || "unknown"}`
    );
    error.code = "BROWSER_VERSION_MISMATCH";
    throw error;
  }
  return true;
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonEmptyIsoString(value) {
  return typeof value === "string" && value.trim().length > 0
    && !Number.isNaN(Date.parse(value));
}

function isCanonicalUtcIsoString(value) {
  if (!isNonEmptyIsoString(value)) return false;
  return new Date(value).toISOString() === value;
}

function isNonEmptyHashMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([key, hash]) => key.trim().length > 0 && isSha256Hex(hash));
}

function evidenceContractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertCanonicalRootRelativePosixPath(value) {
  const reject = (reason) => evidenceContractError(
    "EVIDENCE_RELATIVE_PATH_INVALID",
    `root相対canonical POSIX pathとして使えない値です(${reason}): ${JSON.stringify(typeof value === "string" ? value : String(value))}`,
  );
  if (typeof value !== "string" || value.length === 0) throw reject("非文字列または空値");
  if (value.includes("\0")) throw reject("NUL文字");
  if (value.includes("\\")) throw reject("バックスラッシュ");
  if (path.posix.isAbsolute(value)) throw reject("絶対path");
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") throw reject("空・./..のsegment");
  }
  if (path.posix.normalize(value) !== value) throw reject("正規化で表記が変化");
  return value;
}

function resolveStrictlyWithinApprovedRoot(rootDir, relativePath) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw evidenceContractError("EVIDENCE_PATH_ROOT_INVALID", "approved rootが指定されていません。");
  }
  const approvedRoot = path.resolve(rootDir);
  const canonicalRelativePath = assertCanonicalRootRelativePosixPath(relativePath);
  const resolvedPath = path.resolve(approvedRoot, canonicalRelativePath);
  const backtrack = path.relative(approvedRoot, resolvedPath);
  if (
    backtrack.length === 0
    || backtrack === ".."
    || backtrack.startsWith(`..${path.sep}`)
    || path.isAbsolute(backtrack)
  ) {
    throw evidenceContractError(
      "EVIDENCE_PATH_ESCAPES_APPROVED_ROOT",
      `pathがapproved rootの外に脱します: root=${approvedRoot}, path=${canonicalRelativePath}`,
    );
  }
  return resolvedPath;
}

async function assertSymlinkFreeComponentChain(rootDir, relativePath, options = {}) {
  const { requireFile = false, requireDirectory = false, requireNonEmptyFile = false } = options;
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw evidenceContractError("EVIDENCE_PATH_ROOT_INVALID", "approved rootが指定されていません。");
  }
  const approvedRoot = path.resolve(rootDir);
  const targetPath = resolveStrictlyWithinApprovedRoot(approvedRoot, relativePath);
  const rootStats = await fs.lstat(approvedRoot).catch(() => null);
  if (!rootStats) {
    throw evidenceContractError("EVIDENCE_FS_ROOT_MISSING", `approved rootが存在しません: ${approvedRoot}`);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw evidenceContractError("EVIDENCE_FS_ROOT_INVALID", `approved rootが実directoryではありません: ${approvedRoot}`);
  }
  const segments = path.relative(approvedRoot, targetPath).split(path.sep);
  let current = approvedRoot;
  let lastStats = null;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch {
      const isTail = index === segments.length - 1;
      if (isTail && !requireFile && !requireDirectory && !requireNonEmptyFile) {
        return Object.freeze({ root: approvedRoot, path: targetPath, exists: false, stats: null });
      }
      throw evidenceContractError(
        isTail ? "EVIDENCE_FS_TARGET_MISSING" : "EVIDENCE_FS_COMPONENT_MISSING",
        `approved root配下の存在しないcomponentです: ${current}`,
      );
    }
    if (stats.isSymbolicLink()) {
      throw evidenceContractError("EVIDENCE_FS_SYMLINK_REJECTED", `symlinkを検出しました: ${current}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw evidenceContractError("EVIDENCE_FS_COMPONENT_NOT_DIRECTORY", `中間componentがdirectoryではありません: ${current}`);
    }
    lastStats = stats;
  }
  if ((requireFile || requireNonEmptyFile) && !lastStats.isFile()) {
    throw evidenceContractError("EVIDENCE_FS_FILE_REQUIRED", `通常fileである必要があります: ${targetPath}`);
  }
  if (requireDirectory && !lastStats.isDirectory()) {
    throw evidenceContractError("EVIDENCE_FS_DIRECTORY_REQUIRED", `directoryである必要があります: ${targetPath}`);
  }
  if (requireNonEmptyFile && lastStats.size <= 0) {
    throw evidenceContractError("EVIDENCE_FS_FILE_EMPTY", `fileが空です: ${targetPath}`);
  }
  return Object.freeze({ root: approvedRoot, path: targetPath, exists: true, stats: lastStats });
}

async function computeSha256File(filePath) {
  try {
    const contents = await fs.readFile(filePath);
    return createHash("sha256").update(contents).digest("hex");
  } catch {
    throw evidenceContractError("EVIDENCE_SHA256_UNREADABLE", `SHA-256計算対象のfileを読み込めません: ${filePath}`);
  }
}

function hasExactSameStringKeySet(left, right) {
  const objectLike = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!objectLike(left) || !objectLike(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = new Set(Object.keys(right));
  return leftKeys.length === rightKeys.size && leftKeys.every((key) => rightKeys.has(key));
}

async function collectSymlinkFreeDirectoryInventory(rootDir) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw evidenceContractError("EVIDENCE_PATH_ROOT_INVALID", "approved rootが指定されていません。");
  }
  const approvedRoot = path.resolve(rootDir);
  const rootStats = await fs.lstat(approvedRoot).catch(() => null);
  if (!rootStats) {
    throw evidenceContractError("EVIDENCE_FS_ROOT_MISSING", `inventory対象rootが存在しません: ${approvedRoot}`);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw evidenceContractError("EVIDENCE_FS_ROOT_INVALID", `inventory対象rootが実directoryではありません: ${approvedRoot}`);
  }
  const files = [];
  const directories = [];
  const walk = async (parentRelative) => {
    const parentAbsolute = parentRelative ? path.join(approvedRoot, parentRelative) : approvedRoot;
    let entries;
    try {
      entries = await fs.readdir(parentAbsolute, { encoding: "utf8" });
    } catch {
      throw evidenceContractError("EVIDENCE_INVENTORY_DIR_UNREADABLE", `directory一覧を取得できません: ${parentAbsolute}`);
    }
    for (const entry of entries.sort()) {
      const childRelative = parentRelative ? `${parentRelative}/${entry}` : entry;
      let canonicalChild;
      try {
        canonicalChild = assertCanonicalRootRelativePosixPath(childRelative);
      } catch {
        throw evidenceContractError(
          "EVIDENCE_INVENTORY_PATH_NON_CANONICAL",
          `非canonicalなentry名を検出しました: ${JSON.stringify(childRelative)}`,
        );
      }
      const childAbsolute = path.join(approvedRoot, canonicalChild);
      let stats;
      try {
        stats = await fs.lstat(childAbsolute);
      } catch {
        throw evidenceContractError("EVIDENCE_INVENTORY_ENTRY_UNREADABLE", `entryの状態を取得できません: ${childAbsolute}`);
      }
      if (stats.isSymbolicLink()) {
        throw evidenceContractError("EVIDENCE_INVENTORY_SYMLINK_REJECTED", `symlinkを検出しました: ${childAbsolute}`);
      }
      if (stats.isDirectory()) {
        directories.push(canonicalChild);
        await walk(canonicalChild);
      } else if (stats.isFile()) {
        files.push(canonicalChild);
      } else {
        throw evidenceContractError(
          "EVIDENCE_INVENTORY_SPECIAL_NODE_REJECTED",
          `file/directory以外のnodeを検出しました: ${childAbsolute}`,
        );
      }
    }
  };
  await walk("");
  return Object.freeze({
    root: approvedRoot,
    files: Object.freeze(files.sort()),
    directories: Object.freeze(directories.sort()),
  });
}

export function assertCiEvidenceManifest(manifest, expected = {}) {
  const failures = [];
  if (manifest?.status !== "passed") failures.push("status");
  if (manifest?.browser_started !== true) failures.push("browser_started");
  const identity = manifest?.ci;
  if (!identity || typeof identity !== "object" || identity.identity_source !== "github_actions") {
    failures.push("ci.identity_source");
  }
  for (const [key, expectedKey] of [
    ["run_id", "run_id"],
    ["run_attempt", "run_attempt"],
    ["job", "job"],
  ]) {
    const expectedValue = String(expected[expectedKey] ?? "").trim();
    if (!expectedValue) {
      failures.push(`expected.${expectedKey}`);
      continue;
    }
    if (String(identity?.[key] ?? "") !== expectedValue) failures.push(`ci.${key}`);
  }
  const expectedCommit = String(expected.source_commit ?? "").trim();
  if (!GIT_COMMIT_SHA_PATTERN.test(expectedCommit)) {
    failures.push("expected.source_commit");
  } else {
    if (manifest?.source_commit !== expectedCommit) failures.push("source_commit");
    if (String(identity?.sha ?? "") !== expectedCommit) failures.push("ci.sha");
  }
  const runStartedAtCanonical = isCanonicalUtcIsoString(manifest?.run_started_at);
  const generatedAtCanonical = isCanonicalUtcIsoString(manifest?.generated_at);
  if (!runStartedAtCanonical) failures.push("run_started_at");
  if (!generatedAtCanonical) failures.push("generated_at");
  const nowMs = expected.now_ms == null ? Date.now() : expected.now_ms;
  if (!Number.isFinite(nowMs)) {
    failures.push("expected.now_ms");
  } else if (runStartedAtCanonical && generatedAtCanonical) {
    const startedMs = Date.parse(manifest.run_started_at);
    const generatedMs = Date.parse(manifest.generated_at);
    if (generatedMs < startedMs) failures.push("generated_at_before_run_started_at");
    if (generatedMs - startedMs > 30 * 60 * 1000) failures.push("run_duration_exceeded");
    if (generatedMs - nowMs > 2 * 60 * 1000) failures.push("generated_at_too_far_future");
    if (nowMs - generatedMs > 10 * 60 * 1000) failures.push("generated_at_too_old");
  }
  if (!isNonEmptyHashMap(manifest?.source_sha256)) failures.push("source_sha256");
  if (!isNonEmptyHashMap(manifest?.evidence_sha256)) failures.push("evidence_sha256");
  if (failures.length > 0) {
    const error = new Error(`UI証拠manifestがCI identity照合に失敗しました: ${failures.join(", ")}`);
    error.code = "EVIDENCE_MANIFEST_CI_MISMATCH";
    error.failures = failures;
    throw error;
  }
  return true;
}

export async function verifyCiEvidenceDirectory({ root, env = process.env, evidenceDir, nowMs = Date.now() } = {}) {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw evidenceContractError("EVIDENCE_VERIFY_ROOT_REQUIRED", "検証rootが指定されていません。");
  }
  const approvedRoot = path.resolve(root);
  const identity = resolveEvidenceRunIdentity(env);
  if (identity.identity_source !== "github_actions") {
    throw evidenceContractError(
      "EVIDENCE_VERIFY_CI_IDENTITY_REQUIRED",
      "CI証拠directoryの検証にはgithub_actions identityが必須です。local runの証拠は検証できません。",
    );
  }
  const relativeEvidenceDirectory = `${["output", "playwright"].join("/")}/${buildCiEvidenceDirName(identity)}`;
  const evidenceDirectory = path.join(approvedRoot, relativeEvidenceDirectory);
  const requestedEvidenceDir = String(evidenceDir ?? "").trim();
  if (requestedEvidenceDir) {
    const resolvedRequested = path.isAbsolute(requestedEvidenceDir)
      ? path.normalize(requestedEvidenceDir)
      : path.resolve(approvedRoot, requestedEvidenceDir);
    if (resolvedRequested !== evidenceDirectory) {
      throw evidenceContractError(
        "EVIDENCE_VERIFY_EVIDENCE_DIR_MISMATCH",
        `指定evidence directoryが決定論的pathと一致しません: expected=${evidenceDirectory}, actual=${resolvedRequested}`,
      );
    }
  }

  await assertSymlinkFreeComponentChain(approvedRoot, relativeEvidenceDirectory, { requireDirectory: true });
  const manifestRelativePath = `${relativeEvidenceDirectory}/manifest.json`;
  const exitCodeRelativePath = `${relativeEvidenceDirectory}/exit-code.txt`;
  await assertSymlinkFreeComponentChain(approvedRoot, manifestRelativePath, { requireFile: true });
  await assertSymlinkFreeComponentChain(approvedRoot, exitCodeRelativePath, { requireFile: true });

  const exitCodeBytes = await fs.readFile(path.join(approvedRoot, exitCodeRelativePath));
  if (!exitCodeBytes.equals(Buffer.from("0\n", "utf8"))) {
    throw evidenceContractError("EVIDENCE_VERIFY_EXIT_CODE_INVALID", `exit-code.txtはUTF-8 "0\\n"と一致する必要があります。`);
  }
  let manifest;
  try {
    manifest = JSON.parse((await fs.readFile(path.join(approvedRoot, manifestRelativePath))).toString("utf8"));
  } catch {
    throw evidenceContractError("EVIDENCE_VERIFY_MANIFEST_PARSE_FAILED", "manifest.jsonをJSON objectとして解釈できません。");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw evidenceContractError("EVIDENCE_VERIFY_MANIFEST_PARSE_FAILED", "manifest.jsonはobjectである必要があります。");
  }
  if (manifest.exit_code !== 0) {
    throw evidenceContractError(
      "EVIDENCE_VERIFY_EXIT_CODE_NOT_ZERO",
      `manifest.exit_codeが0ではありません: ${JSON.stringify(manifest.exit_code)}`,
    );
  }
  assertCiEvidenceManifest(manifest, {
    source_commit: identity.sha,
    run_id: identity.run_id,
    run_attempt: identity.run_attempt,
    job: identity.job,
    now_ms: nowMs,
  });
  if (manifest.output_dir !== relativeEvidenceDirectory) {
    throw evidenceContractError(
      "EVIDENCE_VERIFY_OUTPUT_DIR_MISMATCH",
      `manifest.output_dirが決定論的evidence directoryと一致しません: expected=${relativeEvidenceDirectory}, actual=${JSON.stringify(manifest.output_dir)}`,
    );
  }

  const sourceHashMap = manifest.source_sha256;
  if (!hasExactSameStringKeySet(sourceHashMap, Object.fromEntries(REQUIRED_UI_SOURCE_FILES.map((p) => [p, true])))) {
    throw evidenceContractError(
      "EVIDENCE_VERIFY_SOURCE_SHA256_KEYS_MISMATCH",
      "source_sha256のkey集合がREQUIRED_UI_SOURCE_FILESと完全一致しません。",
    );
  }
  for (const sourcePath of REQUIRED_UI_SOURCE_FILES) {
    assertCanonicalRootRelativePosixPath(sourcePath);
    await assertSymlinkFreeComponentChain(approvedRoot, sourcePath, { requireFile: true, requireNonEmptyFile: true });
    const actualHash = await computeSha256File(path.join(approvedRoot, sourcePath));
    if (actualHash !== sourceHashMap[sourcePath]) {
      throw evidenceContractError("EVIDENCE_VERIFY_SOURCE_SHA256_MISMATCH", `source hash不一致: ${sourcePath}`);
    }
  }

  const evidenceEntries = manifest.evidence;
  if (!Array.isArray(evidenceEntries) || evidenceEntries.length === 0) {
    throw evidenceContractError("EVIDENCE_VERIFY_EVIDENCE_LIST_INVALID", "manifest.evidenceは非空arrayである必要があります。");
  }
  const evidenceNames = new Set();
  const evidencePaths = new Set();
  const evidencePathList = [];
  const evidenceRelativePathList = [];
  for (const entry of evidenceEntries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw evidenceContractError("EVIDENCE_VERIFY_EVIDENCE_LIST_INVALID", "manifest.evidenceの要素はobjectである必要があります。");
    }
    const entryName = entry.name;
    if (typeof entryName !== "string" || entryName.trim().length === 0) {
      throw evidenceContractError("EVIDENCE_VERIFY_EVIDENCE_LIST_INVALID", "manifest.evidenceの各要素に非空string nameが必要です。");
    }
    if (evidenceNames.has(entryName)) {
      throw evidenceContractError("EVIDENCE_VERIFY_EVIDENCE_NAME_DUPLICATE", `evidence nameが重複しています: ${entryName}`);
    }
    evidenceNames.add(entryName);
    const entryPath = entry.path;
    try {
      assertCanonicalRootRelativePosixPath(entryPath);
    } catch (error) {
      throw evidenceContractError(
        "EVIDENCE_VERIFY_EVIDENCE_PATH_INVALID",
        `evidence pathがcanonical root相対POSIX形式ではありません: ${JSON.stringify(String(entryPath ?? null))} (${error.message})`,
      );
    }
    if (evidencePaths.has(entryPath)) {
      throw evidenceContractError("EVIDENCE_VERIFY_EVIDENCE_PATH_DUPLICATE", `evidence pathが重複しています: ${entryPath}`);
    }
    evidencePaths.add(entryPath);
    evidencePathList.push(entryPath);
    if (!entryPath.startsWith(`${relativeEvidenceDirectory}/`)) {
      throw evidenceContractError(
        "EVIDENCE_VERIFY_EVIDENCE_PATH_OUTSIDE",
        `evidence pathが決定論的証拠directory配下ではありません: ${entryPath}`,
      );
    }
    const entryAbsolute = path.resolve(approvedRoot, entryPath);
    const entryBacktrack = path.relative(evidenceDirectory, entryAbsolute);
    if (
      entryBacktrack.length === 0
      || entryBacktrack === ".."
      || entryBacktrack.startsWith(`..${path.sep}`)
      || path.isAbsolute(entryBacktrack)
    ) {
      throw evidenceContractError(
        "EVIDENCE_VERIFY_EVIDENCE_PATH_OUTSIDE",
        `evidence pathが決定論的証拠directoryの外または自身を指します: ${entryPath}`,
      );
    }
    evidenceRelativePathList.push(entryBacktrack);
    await assertSymlinkFreeComponentChain(approvedRoot, entryPath, { requireFile: true, requireNonEmptyFile: true });
  }
  if (!hasExactSameStringKeySet(manifest.evidence_sha256, Object.fromEntries(evidencePathList.map((p) => [p, true])))) {
    throw evidenceContractError(
      "EVIDENCE_VERIFY_EVIDENCE_SHA256_KEYS_MISMATCH",
      "evidence_sha256のkey集合がmanifest.evidenceのpath集合と完全一致しません。",
    );
  }
  for (const entryPath of evidencePathList) {
    const actualHash = await computeSha256File(path.join(approvedRoot, entryPath));
    if (actualHash !== manifest.evidence_sha256[entryPath]) {
      throw evidenceContractError("EVIDENCE_VERIFY_EVIDENCE_SHA256_MISMATCH", `evidence hash不一致: ${entryPath}`);
    }
  }

  const inventory = await collectSymlinkFreeDirectoryInventory(evidenceDirectory);
  const allowedFiles = new Set([
    "manifest.json",
    "exit-code.txt",
    ...evidenceRelativePathList,
  ]);
  const extraFiles = inventory.files.filter((found) => !allowedFiles.has(found));
  if (extraFiles.length > 0) {
    throw evidenceContractError("EVIDENCE_VERIFY_EXTRA_FILE", `未bindのfileを検出しました: ${extraFiles.join(", ")}`);
  }
  const allowedDirectories = new Set();
  for (const evidenceRelativePath of evidenceRelativePathList) {
    const nestedSegments = evidenceRelativePath.split("/");
    nestedSegments.pop();
    let prefix = "";
    for (const segment of nestedSegments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      allowedDirectories.add(prefix);
    }
  }
  const extraDirectories = inventory.directories.filter((found) => !allowedDirectories.has(found));
  if (extraDirectories.length > 0) {
    throw evidenceContractError("EVIDENCE_VERIFY_EXTRA_DIRECTORY", `未bindのdirectoryを検出しました: ${extraDirectories.join(", ")}`);
  }
  const missingFiles = [...allowedFiles].filter((expected) => !inventory.files.includes(expected));
  if (missingFiles.length > 0) {
    throw evidenceContractError("EVIDENCE_VERIFY_INVENTORY_INCOMPLETE", `bind済みだが実在しないfileがあります: ${missingFiles.join(", ")}`);
  }
  const missingDirectories = [...allowedDirectories].filter((expected) => !inventory.directories.includes(expected));
  if (missingDirectories.length > 0) {
    throw evidenceContractError("EVIDENCE_VERIFY_INVENTORY_INCOMPLETE", `bind済みだが実在しないdirectoryがあります: ${missingDirectories.join(", ")}`);
  }

  let appCssText;
  try {
    appCssText = await fs.readFile(path.join(approvedRoot, "public/app.css"), "utf8");
  } catch {
    throw evidenceContractError("EVIDENCE_VERIFY_APP_CSS_UNREADABLE", "public/app.cssを読み込めません。");
  }
  const recomputedWidths = buildUiViewportWidths(appCssText);
  const runtimeManifest = manifest.runtime && typeof manifest.runtime === "object" && !Array.isArray(manifest.runtime)
    ? manifest.runtime
    : {};
  for (const [label, widths] of [
    ["responsive_widths", manifest.responsive_widths],
    ["runtime.responsive_widths", runtimeManifest.responsive_widths],
  ]) {
    if (
      !Array.isArray(widths)
      || widths.length !== recomputedWidths.length
      || recomputedWidths.some((width, index) => widths[index] !== width)
    ) {
      throw evidenceContractError(
        "EVIDENCE_VERIFY_RESPONSIVE_WIDTHS_MISMATCH",
        `${label}が再計算幅[${recomputedWidths.join(", ")}]と順序込みで一致しません。`,
      );
    }
  }

  const responsiveChecks = manifest.responsive_checks;
  if (!Array.isArray(responsiveChecks)) {
    throw evidenceContractError("EVIDENCE_VERIFY_RESPONSIVE_CHECKS_INVALID", "manifest.responsive_checksはarrayである必要があります。");
  }
  const boundScreenshots = new Set();
  for (const row of responsiveChecks) {
    const screenshot = row?.screenshot;
    const unbound = (reason) => evidenceContractError(
      "EVIDENCE_VERIFY_SCREENSHOT_UNBOUND",
      `responsive_checksのscreenshotがevidenceにbindされていません(${reason}): ${JSON.stringify(screenshot ?? null)}`,
    );
    try {
      assertCanonicalRootRelativePosixPath(screenshot);
    } catch (error) {
      throw unbound(error.message);
    }
    if (boundScreenshots.has(screenshot)) throw unbound("重複bind");
    if (
      !evidencePaths.has(screenshot)
      || !Object.prototype.hasOwnProperty.call(manifest.evidence_sha256, screenshot)
    ) {
      throw unbound("evidence/evidence_sha256に不在");
    }
    boundScreenshots.add(screenshot);
  }

  await assertEvidenceRunComplete({
    browserStarted: manifest.browser_started === true,
    browserIdentity: manifest.browser_identity,
    expectedWidths: recomputedWidths,
    surfaces: ["mobile", "terminal"],
    responsiveChecks,
    evidenceBaseDir: approvedRoot,
    consoleEvents: manifest.console_events,
    pageErrors: manifest.page_errors,
    httpFailures: manifest.http_failures,
  });

  return Object.freeze({
    evidenceDirectory,
    relativeEvidenceDirectory,
    manifest,
  });
}
