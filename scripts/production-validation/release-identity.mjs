import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export const RELEASE_MANIFEST_SCHEMA_VERSION = "release_manifest_v1";
export const MANIFEST_CLOCK_SKEW_MS = 60_000;
export const RELEASE_MANIFEST_MAX_VALIDITY_MS = 24 * 60 * 60 * 1000;
export const ACCOUNTABLE_SIGNER_ROLES = Object.freeze([
  "legal_accountable",
  "aml_accountable",
  "privacy_accountable",
  "appi_accountable",
  "technology_accountable",
  "operations_accountable",
]);

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

export function normalizeSha256Hex(value) {
  const digest = String(value || "").trim().toLowerCase();
  return SHA256_HEX_PATTERN.test(digest) ? digest : null;
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signedManifestPayload(manifest) {
  const unsigned = { ...(manifest || {}) };
  delete unsigned.signatures;
  delete unsigned.signature;
  return Buffer.from(stableJson(unsigned), "utf8");
}

function canonicalBase64Bytes(value) {
  const encoded = String(value || "");
  if (!encoded || encoded.trim() !== encoded || encoded.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, "base64");
    return decoded.toString("base64") === encoded ? decoded : null;
  } catch (_error) {
    return null;
  }
}

export function validateManifestValidityWindow(
  manifest,
  {
    blockerPrefix = "manifest",
    now = Date.now(),
    maxValidityMs = RELEASE_MANIFEST_MAX_VALIDITY_MS,
    clockSkewMs = MANIFEST_CLOCK_SKEW_MS,
  } = {},
) {
  const blockers = [];
  const issuedAt = Date.parse(String(manifest?.issued_at || ""));
  const expiresAt = Date.parse(String(manifest?.expires_at || ""));
  if (!Number.isFinite(issuedAt)) blockers.push(`${blockerPrefix}_issued_at_invalid`);
  if (!Number.isFinite(expiresAt)) blockers.push(`${blockerPrefix}_expires_at_invalid`);
  if (Number.isFinite(issuedAt) && issuedAt > now + clockSkewMs) blockers.push(`${blockerPrefix}_issued_at_in_future`);
  if (Number.isFinite(expiresAt) && expiresAt <= now) blockers.push(`${blockerPrefix}_expired`);
  if (Number.isFinite(issuedAt) && Number.isFinite(expiresAt)) {
    if (issuedAt >= expiresAt) blockers.push(`${blockerPrefix}_validity_order_invalid`);
    if (Number.isFinite(maxValidityMs) && maxValidityMs > 0 && expiresAt - issuedAt > maxValidityMs) {
      blockers.push(`${blockerPrefix}_validity_window_exceeds_maximum`);
    }
  }
  return { ok: blockers.length === 0, issued_at_ms: issuedAt, expires_at_ms: expiresAt, blockers };
}

export function verifySignedManifestEnvelope(
  manifest,
  env = {},
  {
    root = process.cwd(),
    blockerPrefix = "manifest",
    now = Date.now(),
    trustedKeyPathsEnv = "RELEASE_TRUSTED_PUBLIC_KEY_PATHS",
    revokedKeyIdsEnv = "RELEASE_REVOKED_KEY_IDS",
    signerRegistryEnv = null,
    requiredSignerRoles = [],
    additionalRevokedKeyIds = [],
    allowedSignerKeyIds = null,
    allowedSignerRoleKeyIds = null,
    requireDistinctSignerKeysPerRole = false,
    maxValidityMs = RELEASE_MANIFEST_MAX_VALIDITY_MS,
  } = {}
) {
  const blockers = [];
  const signatures = Array.isArray(manifest?.signatures) ? manifest.signatures : [];
  const payload = signedManifestPayload(manifest);
  const trustedKeys = new Map();
  for (const rawPath of String(env[trustedKeyPathsEnv] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const trustedPath = resolveSafeExistingFile(rawPath, { root });
    if (!trustedPath.ok) continue;
    try {
      const publicKey = fs.readFileSync(trustedPath.path, "utf8").trim();
      if (publicKey) {
        trustedKeys.set(crypto.createHash("sha256").update(publicKey).digest("hex"), publicKey);
      }
    } catch (_error) {
      // Missing/unreadable keys remain a fail-closed blocker below.
    }
  }

  const revokedKeyIds = new Set(
    String(env[revokedKeyIdsEnv] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  for (const keyId of additionalRevokedKeyIds) {
    const normalized = String(keyId || "").trim();
    if (normalized) revokedKeyIds.add(normalized);
  }
  if (trustedKeys.size === 0) blockers.push(`${blockerPrefix}_trusted_key_set_missing`);

  const signerRegistry = new Map();
  const registryRolesByKey = new Map();
  if (signerRegistryEnv) {
    try {
      const rows = JSON.parse(String(env[signerRegistryEnv] || "[]"));
      if (!Array.isArray(rows)) throw new Error("registry_not_array");
      for (const row of rows) {
        const signerRole = String(row?.signer_role || "").trim();
        const keyId = String(row?.key_id || "").trim();
        if (!signerRole || !keyId || !trustedKeys.has(keyId)) {
          blockers.push(`${blockerPrefix}_signer_registry_entry_invalid`);
          continue;
        }
        const allowed = signerRegistry.get(signerRole) || new Set();
        allowed.add(keyId);
        signerRegistry.set(signerRole, allowed);
        const keyRoles = registryRolesByKey.get(keyId) || new Set();
        keyRoles.add(signerRole);
        registryRolesByKey.set(keyId, keyRoles);
      }
      if (requireDistinctSignerKeysPerRole
        && [...registryRolesByKey.values()].some((roles) => roles.size > 1)) {
        blockers.push(`${blockerPrefix}_signer_registry_key_assigned_multiple_roles`);
      }
    } catch (_error) {
      blockers.push(`${blockerPrefix}_signer_registry_invalid`);
    }
  }

  blockers.push(...validateManifestValidityWindow(manifest, {
    blockerPrefix,
    now,
    maxValidityMs,
  }).blockers);
  if (String(manifest?.revocation_status || "").trim().toLowerCase() !== "valid") {
    blockers.push(`${blockerPrefix}_revocation_not_valid`);
  }

  const validSignatureIndexes = [];
  const validSignatures = [];
  const validSignerRoles = new Set();
  const allowedKeys = allowedSignerKeyIds == null ? null : new Set(allowedSignerKeyIds);
  const allowedRoleKeys = allowedSignerRoleKeyIds && typeof allowedSignerRoleKeyIds === "object"
    ? new Map(Object.entries(allowedSignerRoleKeyIds).map(([role, keys]) => [
      role,
      new Set(Array.isArray(keys) ? keys : []),
    ]))
    : null;
  for (const [index, entry] of signatures.entries()) {
    const algorithm = String(entry?.algorithm || "").trim().toLowerCase();
    const publicKey = String(entry?.public_key_pem || entry?.public_key || "").trim();
    const rawEncodedSignature = String(entry?.signature_base64 || entry?.signature || "");
    const encodedSignature = rawEncodedSignature.trim();
    const keyId = String(entry?.key_id || "").trim();
    const signerRole = String(entry?.signer_role || "").trim();
    const trustedPublicKey = trustedKeys.get(keyId);
    if (algorithm !== "ed25519"
      || String(entry?.encoding || "").trim().toLowerCase() !== "base64"
      || !publicKey
      || !encodedSignature
      || !keyId) {
      blockers.push(`${blockerPrefix}_signature_${index}_unsupported`);
      continue;
    }
    const signatureBytes = rawEncodedSignature === encodedSignature
      ? canonicalBase64Bytes(encodedSignature)
      : null;
    if (!signatureBytes || signatureBytes.length !== 64) {
      blockers.push(`${blockerPrefix}_signature_${index}_base64_not_canonical`);
      continue;
    }
    if (!trustedPublicKey || trustedPublicKey.trim() !== publicKey) {
      blockers.push(`${blockerPrefix}_signature_${index}_untrusted_key`);
      continue;
    }
    if (revokedKeyIds.has(keyId)) {
      blockers.push(`${blockerPrefix}_signature_${index}_revoked_key`);
      continue;
    }
    if (allowedKeys && !allowedKeys.has(keyId)) {
      blockers.push(`${blockerPrefix}_signature_${index}_key_not_bound_by_release`);
      continue;
    }
    if (allowedRoleKeys && (!signerRole || !allowedRoleKeys.get(signerRole)?.has(keyId))) {
      blockers.push(`${blockerPrefix}_signature_${index}_role_not_bound_by_release`);
      continue;
    }
    if (signerRegistryEnv && (!signerRole || !signerRegistry.get(signerRole)?.has(keyId))) {
      blockers.push(`${blockerPrefix}_signature_${index}_signer_role_not_trusted`);
      continue;
    }
    try {
      if (crypto.verify(null, payload, publicKey, signatureBytes)) {
        validSignatureIndexes.push(index);
        validSignatures.push({ index, key_id: keyId, signer_role: signerRole || null });
        if (signerRole) validSignerRoles.add(signerRole);
      }
      else blockers.push(`${blockerPrefix}_signature_${index}_invalid`);
    } catch (_error) {
      blockers.push(`${blockerPrefix}_signature_${index}_invalid`);
    }
  }
  if (signatures.length === 0) blockers.push(`${blockerPrefix}_missing_signatures`);
  if (validSignatureIndexes.length === 0) blockers.push(`${blockerPrefix}_no_valid_signature`);
  for (const signerRole of requiredSignerRoles) {
    if (!validSignerRoles.has(signerRole)) blockers.push(`${blockerPrefix}_required_signer_role_missing_${signerRole}`);
  }
  if (requireDistinctSignerKeysPerRole) {
    const rolesByValidKey = new Map();
    for (const signature of validSignatures) {
      if (!requiredSignerRoles.includes(signature.signer_role)) continue;
      const roles = rolesByValidKey.get(signature.key_id) || new Set();
      roles.add(signature.signer_role);
      rolesByValidKey.set(signature.key_id, roles);
    }
    if ([...rolesByValidKey.values()].some((roles) => roles.size > 1)) {
      blockers.push(`${blockerPrefix}_valid_signature_key_used_for_multiple_roles`);
    }
    const keysByRequiredRole = requiredSignerRoles.map((role) => (
      validSignatures.find((signature) => signature.signer_role === role)?.key_id || null
    ));
    if (keysByRequiredRole.every(Boolean) && new Set(keysByRequiredRole).size !== requiredSignerRoles.length) {
      blockers.push(`${blockerPrefix}_required_roles_not_key_separated`);
    }
  }

  return {
    ok: blockers.length === 0,
    valid_signature_indexes: validSignatureIndexes,
    valid_signatures: validSignatures,
    valid_signer_roles: [...validSignerRoles].sort(),
    blockers: [...new Set(blockers)],
  };
}

export function validateReleaseManifestShape(manifest) {
  const blockers = [];
  const releaseId = String(manifest?.release_id || "").trim();
  if (manifest?.schema_version !== RELEASE_MANIFEST_SCHEMA_VERSION) blockers.push("manifest_schema_version_invalid");
  if (!(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(releaseId)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(releaseId))) {
    blockers.push("manifest_release_id_invalid");
  }
  if (!["limited", "commercial"].includes(String(manifest?.mode || "").trim().toLowerCase())) {
    blockers.push("manifest_mode_invalid");
  }
  if (!/^[0-9a-f]{40}$/i.test(String(manifest?.commit || "").trim())) blockers.push("manifest_commit_invalid");
  for (const field of [
    "source_hash",
    "lockfile_hash",
    "migration_hash",
    "env_hash",
    "db_snapshot_hash",
    "backup_hash",
    "evidence_manifest_hash",
    "approval_manifest_hash",
  ]) {
    if (!normalizeSha256Hex(manifest?.[field])) blockers.push(`manifest_${field}_invalid`);
  }
  for (const field of ["base_image_digest", "app_image_digest", "nginx_image_digest"]) {
    if (!normalizeSha256Digest(manifest?.[field])) blockers.push(`manifest_${field}_invalid`);
  }
  if (!manifest?.runtime || typeof manifest.runtime !== "object" || Array.isArray(manifest.runtime)) {
    blockers.push("manifest_runtime_invalid");
  } else if (String(manifest.runtime.node || "").trim() !== "24.17.0") {
    blockers.push("manifest_runtime_node_invalid");
  }
  if (!String(manifest?.audit_root || "").trim()) blockers.push("manifest_audit_root_invalid");
  if (!String(manifest?.environment_id || "").trim()) blockers.push("manifest_environment_id_invalid");
  if (!Array.isArray(manifest?.artifact_hashes)) blockers.push("manifest_artifact_hashes_not_array");

  const trustPolicy = manifest?.trust_policy;
  if (!trustPolicy || typeof trustPolicy !== "object" || Array.isArray(trustPolicy)) {
    blockers.push("manifest_trust_policy_invalid");
  } else {
    const expectedTrustPolicyFields = new Set([
      "release_signer_key_ids",
      "evidence_signer_key_ids",
      "approval_signers",
      "revoked_key_ids",
    ]);
    if (Object.keys(trustPolicy).some((field) => !expectedTrustPolicyFields.has(field))) {
      blockers.push("manifest_trust_policy_unknown_field");
    }
    for (const field of ["release_signer_key_ids", "evidence_signer_key_ids", "revoked_key_ids"]) {
      const values = trustPolicy[field];
      if (!Array.isArray(values)
        || (field !== "revoked_key_ids" && values.length === 0)
        || new Set(values).size !== values.length
        || values.some((value) => !normalizeSha256Hex(value))) {
        blockers.push(`manifest_trust_policy_${field}_invalid`);
      }
    }
    const approvalSigners = trustPolicy.approval_signers;
    if (!approvalSigners || typeof approvalSigners !== "object" || Array.isArray(approvalSigners)) {
      blockers.push("manifest_trust_policy_approval_signers_invalid");
    } else {
      if (Object.keys(approvalSigners).length !== ACCOUNTABLE_SIGNER_ROLES.length
        || Object.keys(approvalSigners).some((role) => !ACCOUNTABLE_SIGNER_ROLES.includes(role))) {
        blockers.push("manifest_trust_policy_approval_signers_roles_invalid");
      }
      const approvalRoleKeySets = [];
      for (const role of ACCOUNTABLE_SIGNER_ROLES) {
        const values = approvalSigners[role];
        if (!Array.isArray(values)
          || values.length === 0
          || new Set(values).size !== values.length
          || values.some((value) => !normalizeSha256Hex(value))) {
          blockers.push(`manifest_trust_policy_approval_signers_${role}_invalid`);
        } else {
          approvalRoleKeySets.push({ role, values: new Set(values) });
        }
      }
      const roleByApprovalKey = new Map();
      for (const { role, values } of approvalRoleKeySets) {
        for (const keyId of values) {
          const priorRole = roleByApprovalKey.get(keyId);
          if (priorRole && priorRole !== role) blockers.push("manifest_trust_policy_accountable_roles_share_key");
          roleByApprovalKey.set(keyId, role);
        }
      }
      const releaseKeys = new Set(trustPolicy.release_signer_key_ids || []);
      const evidenceKeys = new Set(trustPolicy.evidence_signer_key_ids || []);
      const approvalKeys = new Set(roleByApprovalKey.keys());
      if ([...releaseKeys].some((keyId) => evidenceKeys.has(keyId))) {
        blockers.push("manifest_trust_policy_release_evidence_keys_overlap");
      }
      if ([...approvalKeys].some((keyId) => releaseKeys.has(keyId) || evidenceKeys.has(keyId))) {
        blockers.push("manifest_trust_policy_approval_keys_overlap_other_domains");
      }
    }
  }
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
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
