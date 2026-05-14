#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";

function utcTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function stripOutputDirArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--output-dir") {
      i += 1;
      continue;
    }
    if (token.startsWith("--output-dir=")) {
      continue;
    }
    out.push(token);
  }
  return out;
}

function parseOutputBase(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--output-base") {
      return argv[i + 1] || "";
    }
    if (token.startsWith("--output-base=")) {
      return token.split("=", 2)[1] || "";
    }
  }
  return "";
}

function stripOutputBaseArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--output-base") {
      i += 1;
      continue;
    }
    if (token.startsWith("--output-base=")) {
      continue;
    }
    out.push(token);
  }
  return out;
}

function main() {
  const rawArgs = process.argv.slice(2);
  const outputBase = parseOutputBase(rawArgs) || process.env.COMMERCIAL_VALIDATE_SAFE_ROOT || "artifacts/commercial-validate";
  const outputDir = path.resolve(process.cwd(), outputBase, utcTimestamp());

  const cleanedArgs = stripOutputDirArgs(stripOutputBaseArgs(rawArgs));
  if (cleanedArgs.includes("--enforce") || cleanedArgs.includes("--limited-enforce")) {
    const hygiene = spawnSync(
      process.execPath,
      [
        path.join("scripts", "production-validation", "validate-dependency-docker-hygiene.mjs"),
        "--require-resolved-digests",
        "--skip-docker",
        "true",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      }
    );
    if (hygiene.stdout) process.stdout.write(hygiene.stdout);
    if (hygiene.stderr) process.stderr.write(hygiene.stderr);
    if (hygiene.status !== 0) {
      process.exit(Number.isInteger(hygiene.status) ? hygiene.status : 1);
    }
  }
  const run = spawnSync(
    process.execPath,
    [
      path.join("scripts", "production-validation", "validate-commercial-go.mjs"),
      ...cleanedArgs,
      "--output-dir",
      outputDir,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    }
  );

  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  process.exit(Number.isInteger(run.status) ? run.status : 1);
}

main();
