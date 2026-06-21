#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const TEST_DIR = path.join(ROOT, "tests");
const FILE_TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS || 120000);
const GLOBAL_TIMEOUT_MS = Number(process.env.TEST_GLOBAL_TIMEOUT_MS || 0);
const OUTPUT_LIMIT_BYTES = Number(process.env.TEST_OUTPUT_LIMIT_BYTES || 1024 * 1024);
const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const ARTIFACT_DIR = path.join(ROOT, "artifacts", "test-runs", RUN_ID);

function parseArgs(argv) {
  return {
    serial: argv.includes("--serial"),
  };
}

function listTests(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTests(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function appendLimited(current, chunk) {
  const next = current + chunk;
  if (Buffer.byteLength(next) <= OUTPUT_LIMIT_BYTES) return next;
  return next.slice(0, OUTPUT_LIMIT_BYTES) + "\n[output truncated]\n";
}

function writeJson(name, value) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runOne(filePath) {
  return new Promise((resolve) => {
    const relativePath = path.relative(ROOT, filePath);
    const startedAt = new Date().toISOString();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(process.execPath, ["--test", filePath], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref();
    }, FILE_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        file: relativePath,
        pid: child.pid,
        status: timedOut ? "timeout" : code === 0 ? "pass" : "fail",
        exit_code: code,
        signal,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        timeout_ms: FILE_TIMEOUT_MS,
        stdout,
        stderr,
      });
    });
  });
}

async function runPool(files, concurrency) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < files.length) {
      const file = files[index];
      index += 1;
      const result = await runOne(file);
      results.push(result);
      const label = result.status === "pass" ? "PASS" : result.status.toUpperCase();
      process.stdout.write(`${label} ${result.file}\n`);
      if (result.status !== "pass" && result.stderr) process.stderr.write(result.stderr);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = listTests(TEST_DIR);
  const concurrency = args.serial ? 1 : Math.max(1, Math.min(os.availableParallelism?.() || os.cpus().length || 2, 4));
  const globalTimeout = GLOBAL_TIMEOUT_MS || Math.max(600000, FILE_TIMEOUT_MS * Math.max(1, Math.ceil(files.length / concurrency)) + 30000);
  const globalTimer = setTimeout(() => {
    writeJson("summary.json", {
      generated_at: new Date().toISOString(),
      status: "timeout",
      global_timeout_ms: globalTimeout,
      files_total: files.length,
    });
    process.stderr.write(`Global test timeout after ${globalTimeout}ms\n`);
    process.exit(1);
  }, globalTimeout);
  const results = await runPool(files, concurrency);
  clearTimeout(globalTimer);
  const childPids = results.map((result) => ({ file: result.file, pid: result.pid, status: result.status }));
  const failed = results.filter((result) => result.status !== "pass");
  writeJson("child-pids.json", childPids);
  writeJson("summary.json", {
    generated_at: new Date().toISOString(),
    status: failed.length === 0 ? "pass" : "fail",
    node: process.version,
    exec_path: process.execPath,
    concurrency,
    file_timeout_ms: FILE_TIMEOUT_MS,
    global_timeout_ms: globalTimeout,
    files_total: results.length,
    failed: failed.map((result) => ({ file: result.file, status: result.status, exit_code: result.exit_code, signal: result.signal })),
  });
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
