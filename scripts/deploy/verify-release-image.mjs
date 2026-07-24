#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadReleaseManifest } from "../production-validation/validate-commercial-go.mjs";
import {
  extractPinnedImageDigest,
  verifyReleaseImageReferenceContract,
} from "../production-validation/release-identity.mjs";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.split("=", 2);
    const key = rawKey.slice(2);
    if (inlineValue != null) {
      args.set(key, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
      continue;
    }
    args.set(key, "true");
  }
  return args;
}

function loadEnvFile(envFilePath) {
  const values = {};
  for (const rawLine of fs.readFileSync(envFilePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

function inspectLocalImage(imageReference, { expectedCommit = null } = {}) {
  const expectedDigest = extractPinnedImageDigest(imageReference);
  const result = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{json .RepoDigests}}|{{json .Config.Labels}}", imageReference],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    return { ok: false, digest: expectedDigest, blocker: "local_image_not_available_by_digest" };
  }

  let repoDigests = [];
  let labels = {};
  try {
    const [rawRepoDigests, rawLabels] = String(result.stdout || "|").trim().split("|", 2);
    repoDigests = JSON.parse(rawRepoDigests || "[]");
    labels = JSON.parse(rawLabels || "{}") || {};
  } catch (_error) {
    return { ok: false, digest: expectedDigest, blocker: "local_image_repo_digests_invalid" };
  }
  const matched = Array.isArray(repoDigests)
    && repoDigests.some((value) => String(value).toLowerCase().endsWith(`@${expectedDigest}`));
  const revision = String(labels["org.opencontainers.image.revision"] || "").trim();
  const revisionMatched = !expectedCommit || revision === String(expectedCommit).trim();
  return {
    ok: matched && revisionMatched,
    digest: expectedDigest,
    revision,
    blocker: !matched
      ? "local_image_digest_not_verified"
      : (revisionMatched ? null : "local_image_revision_label_mismatch"),
  };
}

export function verifyReleaseDeploymentContract({ env, manifestResult, inspectImages = true }) {
  const blockers = [...(manifestResult?.blockers || [])];
  const referenceVerification = verifyReleaseImageReferenceContract({
    manifest: manifestResult?.manifest,
    appImageRef: env.APP_IMAGE_REF,
    nginxImageRef: env.NGINX_IMAGE_REF,
  });
  blockers.push(...referenceVerification.blockers);

  const imageInspection = {};
  if (inspectImages && referenceVerification.ok) {
    imageInspection.app = inspectLocalImage(env.APP_IMAGE_REF, {
      expectedCommit: manifestResult?.manifest?.commit,
    });
    imageInspection.nginx = inspectLocalImage(env.NGINX_IMAGE_REF);
    for (const result of Object.values(imageInspection)) {
      if (!result.ok && result.blocker) blockers.push(result.blocker);
    }
  }

  return {
    ok: blockers.length === 0,
    release_id: manifestResult?.manifest?.release_id || null,
    commit: manifestResult?.manifest?.commit || null,
    manifest_path: manifestResult?.path || null,
    app_image_digest: referenceVerification.app_image_digest,
    nginx_image_digest: referenceVerification.nginx_image_digest,
    base_image_digest: referenceVerification.base_image_digest,
    image_inspection: imageInspection,
    blockers: [...new Set(blockers)],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.get("root") || process.cwd());
  const envFile = path.resolve(root, args.get("env-file") || ".env.production");
  if (!fs.existsSync(envFile)) {
    console.error(JSON.stringify({ ok: false, blockers: ["env_file_missing"] }, null, 2));
    process.exit(1);
  }

  const env = { ...loadEnvFile(envFile), ...process.env };
  const manifestResult = loadReleaseManifest(env.RELEASE_MANIFEST, env, { root });
  const report = verifyReleaseDeploymentContract({
    env,
    manifestResult,
    inspectImages: args.get("skip-docker-inspect") !== "true",
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
