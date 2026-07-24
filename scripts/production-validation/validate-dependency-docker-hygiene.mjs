#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();

function ensure(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, inlineValue] = token.split("=", 2);
    if (inlineValue != null) {
      args.set(key.slice(2), inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key.slice(2), next);
      i += 1;
      continue;
    }
    args.set(key.slice(2), "true");
  }
  return args;
}

function readText(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

function hasDocker() {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch (_error) {
    return false;
  }
}

function runNpmCiDryRun() {
  execFileSync("npm", ["ci", "--ignore-scripts", "--dry-run"], {
    cwd: ROOT,
    stdio: "ignore",
  });
}

function collectLicensesFromLockfile(lockfile) {
  const packages = lockfile.packages || {};
  const rows = [];
  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (!pkgPath.startsWith("node_modules/")) continue;
    rows.push({
      package: pkgPath.replace(/^node_modules\//, ""),
      version: meta.version || null,
      license: meta.license || "UNKNOWN",
    });
  }
  rows.sort((left, right) => left.package.localeCompare(right.package));
  return rows;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = args.get("output") ? path.resolve(ROOT, args.get("output")) : null;
  const skipDocker = args.get("skip-docker") === "true";
  const checks = [];

  function record(name, ok, details = {}) {
    checks.push({ name, ok, ...details });
  }

  try {
    ensure(fs.existsSync(path.join(ROOT, "package-lock.json")), "package-lock.json is required");
    ensure(fs.existsSync(path.join(ROOT, "package.json")), "package.json is required");
    record("lockfile_present", true);

    runNpmCiDryRun();
    record("npm_ci_dry_run", true);

    const dockerignore = readText(".dockerignore");
    for (const pattern of [
      ".env",
      ".env.production",
      "runtime",
      "docs/production/evidence",
      "*.db",
      "*.sqlite",
      "deploy/nginx/certs",
    ]) {
      ensure(dockerignore.includes(pattern), `.dockerignore must exclude ${pattern}`, { pattern });
    }
    record("dockerignore_secret_patterns", true);

    const dockerfile = readText("Dockerfile");
    ensure(/npm ci --omit=dev/.test(dockerfile), "Dockerfile must use npm ci --omit=dev");
    ensure(/FROM node@sha256:[a-f0-9]{64} AS deps/.test(dockerfile), "Dockerfile deps stage must pin Node image by digest");
    ensure(/FROM node@sha256:[a-f0-9]{64} AS runtime/.test(dockerfile), "Dockerfile runtime stage must pin Node image by digest");
    ensure(/USER appuser/.test(dockerfile), "Dockerfile must drop root privileges");
    ensure(/org\.opencontainers\.image\.revision/.test(dockerfile), "Dockerfile must label the source commit");
    ensure(!/COPY \. \./.test(dockerfile), "Dockerfile must not copy the full workspace blindly");
    record("dockerfile_runtime_hardening", true);

    const compose = readText("docker-compose.prod.yml");
    ensure(/\.env\.production/.test(compose), "docker-compose.prod.yml must reference .env.production");
    ensure(!/^\s+build:/m.test(compose), "production compose must not build images on the deployment host");
    ensure(/\$\{APP_IMAGE_REF:\?/.test(compose), "production compose must require APP_IMAGE_REF");
    ensure(/\$\{NGINX_IMAGE_REF:\?/.test(compose), "production compose must require NGINX_IMAGE_REF");
    ensure(!/jpyc-terminal-production:local/.test(compose), "production compose must not use a mutable local app image tag");
    ensure(!/condition:\s*service_started/.test(compose), "workers must wait for app health, not service start");
    ensure((compose.match(/condition:\s*service_healthy/g) || []).length >= 5, "compose readiness ordering must be health-based");
    for (const requiredControl of ["read_only: true", "cap_drop:", "no-new-privileges:true", "tmpfs:", "pids_limit:"]) {
      ensure(compose.includes(requiredControl), `production compose must include ${requiredControl}`);
    }
    record("compose_release_and_runtime_hardening", true);

    const systemd = readText("deploy/systemd/jpyc-payment-terminal.service");
    ensure(!/up\s+--build/.test(systemd), "systemd must not rebuild the release image");
    ensure(/up\s+--no-build\s+--pull never/.test(systemd), "systemd must start the verified image without build or implicit pull");
    ensure(/verify-release-image\.mjs/.test(systemd), "systemd must verify release image identity before start");
    ensure(/compose\s+--env-file \.env\.production/.test(systemd), "systemd compose commands must use the production interpolation env file");
    record("systemd_release_identity_preflight", true);

    const lockfile = JSON.parse(readText("package-lock.json"));
    const licenses = collectLicensesFromLockfile(lockfile);
    ensure(licenses.length > 0, "license export must contain at least one dependency");
    record("license_list_exportable", true, { count: licenses.length });

    let dockerBuildStatus = { skipped: true, reason: "docker_unavailable" };
    if (!skipDocker && hasDocker()) {
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
      ensure(/^[a-f0-9]{40}$/.test(sourceCommit), "Docker build requires an exact source commit");
      execFileSync("docker", [
        "build",
        "--build-arg",
        `SOURCE_COMMIT=${sourceCommit}`,
        ".",
        "--tag",
        "jpyc-terminal-production:hygiene",
      ], {
        cwd: ROOT,
        stdio: "ignore",
      });
      dockerBuildStatus = { skipped: false, source_commit: sourceCommit };
    }
    record("docker_build", true, dockerBuildStatus);

    const summary = {
      ok: true,
      generated_at: new Date().toISOString(),
      checks,
      licenses,
    };
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
    }
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    const summary = {
      ok: false,
      generated_at: new Date().toISOString(),
      checks: [...checks, {
        name: "dependency_docker_hygiene",
        ok: false,
        message: String(error.message || error),
        details: error.details || {},
      }],
    };
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
    }
    console.log(JSON.stringify(summary, null, 2));
    process.exit(1);
  }
}

main();
