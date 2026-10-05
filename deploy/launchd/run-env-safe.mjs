#!/usr/bin/env node
// Safe launcher for launchd-managed JPYC terminal processes (local Mac).
//
// Contract:
//   node run-env-safe.mjs --cwd <repo-dir> --env-file <repo-dir>/.env.production \
//     [--allow-exec <abs-path> ...] -- <target.mjs> [target-args...]
//
// Guarantees:
// - The child is spawned WITHOUT a shell (no string concatenation into a
//   command line), so env values can never be interpreted as shell syntax.
// - The env file must be a regular file with permission mode exactly 0600;
//   group/world-readable secret files are refused.
// - Env lines are parsed strictly. Invalid lines (bad key, missing "=",
//   duplicates, unsupported "export " prefix, oversized values) abort the
//   launch. Values are passed verbatim: no expansion, no quote processing,
//   never logged. Error messages identify the line number only.
// - The working directory (--cwd) and the executable (process.execPath vs
//   --allow-exec entries, compared by realpath) are allowlisted.
// - Only known entrypoints inside the allowed working directory may be
//   launched:
//     src/server.mjs                          (terminal app)
//     src/chain-monitor.mjs                   (chain worker)
//     scripts/verify-audit-chain.mjs          (audit-watch: fail-closed)
//     deploy/launchd/targets/backup-sqlite.mjs  (periodic SQLite backup;
//                                               wraps scripts/deploy/
//                                               backup-sqlite.sh without a
//                                               shell string)
//     deploy/launchd/targets/health-watch.mjs   (loopback /healthz + worker
//                                               freshness check)
// - The pinned Node version is enforced; the runner refuses any other
//   runtime so launchd cannot silently upgrade the interpreter.
// - Catchable termination signals are forwarded to the child. SIGKILL cannot
//   be caught or forwarded by any process; launchd may use it only after the
//   configured graceful shutdown window expires.
//
// This file intentionally prints neither env keys' values nor file contents.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

export const PINNED_NODE_VERSION = "v24.17.0";

const TARGET_ALLOWLIST = Object.freeze([
  "src/server.mjs",
  "src/chain-monitor.mjs",
  "scripts/verify-audit-chain.mjs",
  "deploy/launchd/targets/backup-sqlite.mjs",
  "deploy/launchd/targets/health-watch.mjs",
]);
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_KEY_LENGTH = 128;
const MAX_ENV_VALUE_LENGTH = 8192;
const ENV_FILE_BASENAME_PATTERN = /^\.env(\.[A-Za-z0-9._-]+)?$/;
// Only innocuous ambient variables are inherited; everything else must come
// from the 0600 env file itself so launchd context cannot leak into the app.
const PASSTHROUGH_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME",
]);

export function parseEnvFileLines(rawText) {
  const values = new Map();
  const errors = [];
  const lines = String(rawText ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    if (trimmedLine.startsWith("export ")) {
      errors.push({ line: lineNumber, reason: "export_prefix_unsupported" });
      continue;
    }
    const separator = rawLine.indexOf("=");
    if (separator <= 0) {
      errors.push({ line: lineNumber, reason: separator < 0 ? "missing_equals" : "empty_key" });
      continue;
    }
    const key = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1);
    if (!ENV_KEY_PATTERN.test(key)) {
      errors.push({ line: lineNumber, reason: "invalid_key" });
      continue;
    }
    if (key.length > MAX_ENV_KEY_LENGTH) {
      errors.push({ line: lineNumber, reason: "key_too_long" });
      continue;
    }
    if (value.length > MAX_ENV_VALUE_LENGTH) {
      errors.push({ line: lineNumber, reason: "value_too_long" });
      continue;
    }
    if (value.includes("\0")) {
      errors.push({ line: lineNumber, reason: "nul_in_value" });
      continue;
    }
    if (values.has(key)) {
      errors.push({ line: lineNumber, reason: "duplicate_key" });
      continue;
    }
    values.set(key, value);
  }
  return { values, errors };
}

function buildChildEnv(values) {
  const env = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  for (const [key, value] of values) env[key] = value;
  return env;
}

function realpathOrNone(target) {
  try {
    return fs.realpathSync(target);
  } catch (_error) {
    return null;
  }
}

function parseArgs(argv) {
  const options = { allowExec: [], targetArgs: [], sawSeparator: false, envFile: "", cwd: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (options.sawSeparator) {
      options.targetArgs.push(token);
      continue;
    }
    if (token === "--") {
      options.sawSeparator = true;
      continue;
    }
    if (token === "--allow-exec") {
      const next = argv[i + 1];
      if (!next) return { error: "allow_exec_requires_value" };
      options.allowExec.push(next);
      i += 1;
      continue;
    }
    const inline = token.startsWith("--");
    if (!inline) return { error: `unexpected_argument` };
    const equals = token.indexOf("=");
    const key = equals > 0 ? token.slice(2, equals) : token.slice(2);
    const value = equals > 0 ? token.slice(equals + 1) : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
    if (value === undefined || value === "") return { error: `${key}_requires_value` };
    if (equals < 0) i += 1;
    if (key === "env-file") options.envFile = value;
    else if (key === "cwd") options.cwd = value;
    else return { error: `unknown_option:${key}` };
  }
  return { options };
}

export function resolveRunnerPlan(
  argv,
  { execPath = process.execPath, statSync = fs.statSync, runtimeVersion = process.version } = {}
) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { ok: false, code: parsed.error };
  const options = parsed.options;

  if (!PINNED_NODE_VERSION || String(runtimeVersion) !== PINNED_NODE_VERSION) {
    return { ok: false, code: "node_version_mismatch", detail: PINNED_NODE_VERSION };
  }

  if (!options.cwd) return { ok: false, code: "cwd_required" };
  const cwdReal = realpathOrNone(options.cwd);
  if (!cwdReal) return { ok: false, code: "cwd_not_resolvable" };
  if (!fs.statSync(cwdReal).isDirectory()) return { ok: false, code: "cwd_not_directory" };

  // Executable allowlist: compare realpaths so symlinked installs (for example
  // Homebrew opt paths) still match the operator-approved binary.
  if (!Array.isArray(options.allowExec) || options.allowExec.length === 0) {
    return { ok: false, code: "allow_exec_required" };
  }
  const execReal = realpathOrNone(execPath);
  if (!execReal) return { ok: false, code: "exec_not_resolvable" };
  const allowListed = options.allowExec.some((entry) => realpathOrNone(entry) === execReal);
  if (!allowListed) return { ok: false, code: "exec_not_allowlisted" };

  if (!options.envFile) return { ok: false, code: "env_file_required" };
  const envFileResolved = path.resolve(options.envFile);
  if (!ENV_FILE_BASENAME_PATTERN.test(path.basename(envFileResolved))) {
    return { ok: false, code: "env_file_name_rejected" };
  }
  let stats;
  try {
    stats = statSync(envFileResolved);
  } catch (_error) {
    return { ok: false, code: "env_file_not_readable" };
  }
  if (!stats.isFile()) return { ok: false, code: "env_file_not_regular" };
  if ((stats.mode & 0o777) !== 0o600) {
    return { ok: false, code: "env_file_mode_not_0600" };
  }
  // Compare realpaths so symlinked parents (for example /tmp -> /private/tmp)
  // cannot smuggle an env file in from outside the allowed working directory.
  const envFileReal = realpathOrNone(envFileResolved);
  if (!envFileReal || !envFileReal.startsWith(`${cwdReal}${path.sep}`)) {
    return { ok: false, code: "env_file_outside_cwd" };
  }
  let rawText;
  try {
    rawText = fs.readFileSync(envFileReal, "utf8");
  } catch (_error) {
    return { ok: false, code: "env_file_not_readable" };
  }
  const { values, errors } = parseEnvFileLines(rawText);
  if (errors.length > 0) {
    return { ok: false, code: "env_file_invalid_lines", lines: errors };
  }
  if (values.size === 0) {
    return { ok: false, code: "env_file_empty" };
  }

  if (options.targetArgs.length === 0) return { ok: false, code: "target_required" };
  const target = options.targetArgs[0];
  if (path.isAbsolute(target)) return { ok: false, code: "target_must_be_relative" };
  const normalized = path.normalize(target);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return { ok: false, code: "target_escapes_cwd" };
  }
  if (!TARGET_ALLOWLIST.includes(normalized)) {
    return { ok: false, code: "target_not_allowlisted" };
  }
  const targetReal = realpathOrNone(path.join(cwdReal, normalized));
  if (!targetReal || !targetReal.startsWith(`${cwdReal}${path.sep}`)) {
    return { ok: false, code: "target_not_resolvable_inside_cwd" };
  }

  return {
    ok: true,
    plan: {
      cwd: cwdReal,
      envFile: envFileReal,
      env: buildChildEnv(values),
      execPath: execReal,
      args: [...options.targetArgs],
    },
  };
}

function fail(code, extra = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, code, ...extra })}\n`);
  process.exit(78);
}

export async function main(argv = process.argv.slice(2)) {
  const planResult = resolveRunnerPlan(argv);
  if (!planResult.ok) {
    fail(planResult.code, {
      ...(planResult.detail ? { detail: planResult.detail } : {}),
      ...(Array.isArray(planResult.lines) ? { lines: planResult.lines } : {}),
    });
  }
  const { cwd, env, execPath, args } = planResult.plan;
  const child = spawn(execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });
  const forwardedSignals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const signalForwarders = new Map(forwardedSignals.map((signal) => [
    signal,
    () => {
      if (!child.killed) child.kill(signal);
    },
  ]));
  for (const [signal, handler] of signalForwarders) process.once(signal, handler);
  const removeSignalForwarders = () => {
    for (const [signal, handler] of signalForwarders) process.removeListener(signal, handler);
  };
  child.on("error", (error) => {
    removeSignalForwarders();
    process.stderr.write(`${JSON.stringify({ ok: false, code: "spawn_failed", message: String(error?.code || "unknown") })}\n`);
    process.exit(70);
  });
  child.on("exit", (code, signal) => {
    removeSignalForwarders();
    if (signal) {
      process.stderr.write(`${JSON.stringify({ ok: false, code: "child_signalled", signal })}\n`);
      process.exit(1);
    }
    process.exit(typeof code === "number" ? code : 1);
  });
}

// Entry detection must compare realpaths: ESM canonicalizes import.meta.url
// through symlinks (for example /tmp -> /private/tmp on macOS or a symlinked
// install root), so comparing the unresolved argv[1] path silently skips
// main() and exits 0 without launching anything.
function isInvokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch (_error) {
    try {
      return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
    } catch (_innerError) {
      return false;
    }
  }
}

if (isInvokedAsMain()) {
  await main();
}
