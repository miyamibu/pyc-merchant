#!/usr/bin/env node
// launchd target: periodic SQLite backup for the local_store_terminal topology.
//
// This wrapper intentionally reuses scripts/deploy/backup-sqlite.sh (the
// canonical backup implementation) instead of duplicating its logic. It is
// launched through deploy/launchd/run-env-safe.mjs, so:
// - DB_PATH and BACKUP_DIR come from the 0600 .env.production via the safe
//   runner environment; this wrapper fails closed when either is missing so
//   launchd can never fall back to guessed repo-local default paths.
// - The shell script is spawned as a fixed argv array (/bin/bash + absolute
//   script path). There is no eval, no string-concatenated command line, and
//   no secret value is ever printed by this wrapper.
// - PATH is prefixed with the directory of the running (pinned) Node binary
//   so the script's internal `node` invocation resolves to exactly the same
//   pinned runtime that passed run-env-safe.mjs version enforcement.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(code) {
  emit({ ok: false, code });
  process.exit(1);
}

const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
// deploy/launchd/targets/<this file> -> repo root is three levels up.
const repoRoot = path.resolve(path.dirname(modulePath), "..", "..", "..");
const bashPath = "/bin/bash";
const scriptPath = path.join(repoRoot, "scripts", "deploy", "backup-sqlite.sh");

try {
  if (!fs.statSync(bashPath).isFile()) fail("bash_not_found");
} catch {
  fail("bash_not_found");
}
if (!fs.existsSync(scriptPath)) fail("backup_script_missing");

const dbPath = String(process.env.DB_PATH ?? "").trim();
const backupDir = String(process.env.BACKUP_DIR ?? "").trim();
if (!dbPath) fail("db_path_required");
if (!backupDir) fail("backup_dir_required");

const childEnv = { ...process.env };
const pinnedNodeBinDir = path.dirname(process.execPath);
childEnv.PATH = `${pinnedNodeBinDir}:${String(childEnv.PATH || "/usr/bin:/bin")}`;

emit({ ok: true, code: "backup_started" });

const child = spawn(bashPath, [scriptPath], {
  cwd: repoRoot,
  env: childEnv,
  stdio: ["ignore", "inherit", "inherit"],
  shell: false,
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  emit({ ok: false, code: "spawn_failed", message: String(error?.code || "unknown") });
  process.exit(70);
});

child.on("exit", (code, signal) => {
  if (signal) {
    emit({ ok: false, code: "backup_signalled", signal });
    process.exit(1);
  }
  const exitCode = typeof code === "number" ? code : 1;
  if (exitCode !== 0) emit({ ok: false, code: "backup_failed", exit_code: exitCode });
  else emit({ ok: true, code: "backup_finished" });
  process.exit(exitCode);
});
