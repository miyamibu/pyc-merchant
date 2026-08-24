#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const EXIT_NO_GO = 10;
const EXIT_TOOL_FAILURE = 12;
const rawArgs = process.argv.slice(2);
const hasOutputDir = rawArgs.some((arg) => arg === "--output-dir" || arg.startsWith("--output-dir="));
const outputArgs = hasOutputDir
  ? rawArgs
  : [...rawArgs, "--output-dir", path.join("artifacts", "work", "gates", "limited", new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"))];

const run = spawnSync(
  process.execPath,
  [path.join("scripts", "production-validation", "validate-commercial-go.mjs"), ...outputArgs],
  {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  }
);

if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);

if (run.status !== 0) process.exit(EXIT_TOOL_FAILURE);

let parsed = null;
try {
  parsed = JSON.parse(String(run.stdout || "{}"));
} catch (_error) {
  process.exit(EXIT_TOOL_FAILURE);
}

process.exit(parsed.verdict === "LIMITED_PILOT_GO" ? 0 : EXIT_NO_GO);
