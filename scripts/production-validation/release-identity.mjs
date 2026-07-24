import fs from "node:fs";
import path from "node:path";

export const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isWithinRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function resolveSafeExistingFile(rawPath, { root = process.cwd() } = {}) {
  const candidate = String(rawPath || "").trim();
  if (!candidate) return { ok: false, path: null, reason: "missing" };

  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync(root);
  } catch (_error) {
    return { ok: false, path: null, reason: "root_unavailable" };
  }

  const resolvedPath = path.resolve(rootRealPath, candidate);
  if (!isWithinRoot(rootRealPath, resolvedPath)) {
    return { ok: false, path: null, reason: "outside_root" };
  }

  const relativeParts = path.relative(rootRealPath, resolvedPath).split(path.sep).filter(Boolean);
  let currentPath = rootRealPath;
  try {
    for (const part of relativeParts) {
      currentPath = path.join(currentPath, part);
      const stat = fs.lstatSync(currentPath);
      if (stat.isSymbolicLink()) {
        return { ok: false, path: null, reason: "symlink" };
      }
    }

    const realPath = fs.realpathSync(resolvedPath);
    if (!isWithinRoot(rootRealPath, realPath)) {
      return { ok: false, path: null, reason: "realpath_outside_root" };
    }
    if (!fs.statSync(realPath).isFile()) {
      return { ok: false, path: null, reason: "not_regular_file" };
    }
    return { ok: true, path: realPath, reason: null };
  } catch (_error) {
    return { ok: false, path: null, reason: "missing" };
  }
}

export function normalizeSha256Digest(value) {
  const digest = String(value || "").trim().toLowerCase();
  return SHA256_DIGEST_PATTERN.test(digest) ? digest : null;
}

export function extractPinnedImageDigest(imageReference) {
  const reference = String(imageReference || "").trim();
  const separatorIndex = reference.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === reference.length - 1) return null;
  return normalizeSha256Digest(reference.slice(separatorIndex + 1));
}

export function verifyReleaseImageReferenceContract({ manifest, appImageRef, nginxImageRef }) {
  const blockers = [];
  const manifestAppDigest = normalizeSha256Digest(manifest?.app_image_digest);
  const manifestNginxDigest = normalizeSha256Digest(manifest?.nginx_image_digest);
  const manifestBaseDigest = normalizeSha256Digest(manifest?.base_image_digest);
  const appImageDigest = extractPinnedImageDigest(appImageRef);
  const nginxImageDigest = extractPinnedImageDigest(nginxImageRef);

  if (!manifestAppDigest) blockers.push("manifest_app_image_digest_invalid");
  if (!manifestNginxDigest) blockers.push("manifest_nginx_image_digest_invalid");
  if (!manifestBaseDigest) blockers.push("manifest_base_image_digest_invalid");
  if (!appImageDigest) blockers.push("app_image_ref_must_be_digest_pinned");
  if (!nginxImageDigest) blockers.push("nginx_image_ref_must_be_digest_pinned");
  if (manifestAppDigest && appImageDigest && manifestAppDigest !== appImageDigest) {
    blockers.push("manifest_app_image_digest_mismatch_app_image_ref");
  }
  if (manifestNginxDigest && nginxImageDigest && manifestNginxDigest !== nginxImageDigest) {
    blockers.push("manifest_nginx_image_digest_mismatch_nginx_image_ref");
  }

  return {
    ok: blockers.length === 0,
    app_image_digest: appImageDigest,
    nginx_image_digest: nginxImageDigest,
    manifest_nginx_image_digest: manifestNginxDigest,
    base_image_digest: manifestBaseDigest,
    blockers,
  };
}
