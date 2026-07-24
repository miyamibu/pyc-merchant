import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { verifyReleaseDeploymentContract } from "../scripts/deploy/verify-release-image.mjs";
import {
  extractPinnedImageDigest,
  resolveSafeExistingFile,
  verifyReleaseImageReferenceContract,
} from "../scripts/production-validation/release-identity.mjs";
import { loadReleaseManifest, verifyManifestArtifacts } from "../scripts/production-validation/validate-commercial-go.mjs";

const APP_DIGEST = `sha256:${"1".repeat(64)}`;
const NGINX_DIGEST = `sha256:${"2".repeat(64)}`;
const BASE_DIGEST = `sha256:${"3".repeat(64)}`;
const ROOT = process.cwd();

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createArtifactFixture(root) {
  const fields = ["source_hash", "lockfile_hash", "migration_hash", "env_hash", "db_snapshot_hash", "backup_hash"];
  const manifest = { artifact_hashes: [] };
  for (const field of fields) {
    const relativePath = `release/${field}.txt`;
    const content = `${field}-fixture`;
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content, "utf8");
    const digest = sha256(content);
    manifest[field] = digest;
    manifest.artifact_hashes.push({ field, path: relativePath, sha256: digest });
  }
  return manifest;
}

test("release artifact verification accepts regular files within the release root", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "jpyc-release-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = createArtifactFixture(root);
  const result = verifyManifestArtifacts(manifest, { root });
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  assert.equal(result.verified_fields.length, 6);
});

test("release artifact verification rejects symlinks even when their hash matches", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "jpyc-release-symlink-root-"));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "jpyc-release-symlink-outside-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const manifest = createArtifactFixture(root);
  const outsidePath = path.join(outsideRoot, "source.txt");
  fs.writeFileSync(outsidePath, "outside-source", "utf8");
  const symlinkPath = path.join(root, "release", "source-symlink.txt");
  fs.symlinkSync(outsidePath, symlinkPath);
  const digest = sha256("outside-source");
  manifest.source_hash = digest;
  manifest.artifact_hashes = manifest.artifact_hashes.map((entry) => (
    entry.field === "source_hash" ? { ...entry, path: "release/source-symlink.txt", sha256: digest } : entry
  ));

  assert.equal(resolveSafeExistingFile("release/source-symlink.txt", { root }).reason, "symlink");
  const result = verifyManifestArtifacts(manifest, { root });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("manifest_artifact_unsafe_symlink_source_hash"));
});

test("release image references require registry digests and must match the manifest", () => {
  const manifest = { app_image_digest: APP_DIGEST, nginx_image_digest: NGINX_DIGEST, base_image_digest: BASE_DIGEST };
  const valid = verifyReleaseImageReferenceContract({
    manifest,
    appImageRef: `registry.example/jpyc@${APP_DIGEST}`,
    nginxImageRef: `registry.example/nginx@${NGINX_DIGEST}`,
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.blockers));
  assert.equal(extractPinnedImageDigest(`registry.example/jpyc@${APP_DIGEST}`), APP_DIGEST);

  const mutableTag = verifyReleaseImageReferenceContract({
    manifest,
    appImageRef: "registry.example/jpyc:latest",
    nginxImageRef: `registry.example/nginx@${NGINX_DIGEST}`,
  });
  assert.equal(mutableTag.ok, false);
  assert.ok(mutableTag.blockers.includes("app_image_ref_must_be_digest_pinned"));
});

test("release manifest selection rejects a symlink before parsing", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "jpyc-release-manifest-root-"));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "jpyc-release-manifest-outside-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "release"), { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, "manifest.json"), "{}", "utf8");
  fs.symlinkSync(path.join(outsideRoot, "manifest.json"), path.join(root, "release", "manifest.json"));

  const result = loadReleaseManifest("release/manifest.json", {}, { root });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("unsafe_release_manifest_path_symlink"));
});

test("deployment preflight contract binds manifest app digest to APP_IMAGE_REF", () => {
  const manifest = {
    release_id: "release-test",
    commit: "a".repeat(40),
    app_image_digest: APP_DIGEST,
    nginx_image_digest: NGINX_DIGEST,
    base_image_digest: BASE_DIGEST,
  };
  const report = verifyReleaseDeploymentContract({
    env: {
      APP_IMAGE_REF: `registry.example/jpyc@sha256:${"4".repeat(64)}`,
      NGINX_IMAGE_REF: `registry.example/nginx@${NGINX_DIGEST}`,
    },
    manifestResult: { ok: true, path: "/release/manifest.json", manifest, blockers: [] },
    inspectImages: false,
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockers.includes("manifest_app_image_digest_mismatch_app_image_ref"));
});

test("production deployment contract forbids host builds and orders services by health", () => {
  const compose = fs.readFileSync(path.join(ROOT, "docker-compose.prod.yml"), "utf8");
  const systemd = fs.readFileSync(path.join(ROOT, "deploy/systemd/jpyc-payment-terminal.service"), "utf8");

  assert.doesNotMatch(compose, /^\s+build:/m);
  assert.doesNotMatch(compose, /condition:\s*service_started/);
  assert.match(compose, /\$\{APP_IMAGE_REF:\?/);
  assert.match(compose, /\$\{NGINX_IMAGE_REF:\?/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /WORKER_STALE_SEC/);
  assert.match(compose, /Date\.now\(\)-cycleAt<=staleMs/);
  assert.doesNotMatch(systemd, /up\s+--build/);
  assert.match(systemd, /verify-release-image\.mjs/);
  assert.match(systemd, /up\s+--no-build\s+--pull never/);
});
