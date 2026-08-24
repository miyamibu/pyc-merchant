import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNTABLE_SIGNER_ROLES,
  normalizeSha256Digest,
  normalizeSha256Hex,
  resolveSafeExistingFile,
  sha256File,
  validateReleaseManifestShape,
  verifySignedManifestEnvelope,
} from "./release-identity.mjs";

export const EVIDENCE_MANIFEST_SCHEMA_VERSION = "commercial_evidence_manifest_v1";
export const APPROVAL_MANIFEST_SCHEMA_VERSION = "commercial_approval_manifest_v1";
export const EVIDENCE_MANIFEST_MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
export const APPROVAL_MANIFEST_MAX_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;

export const REQUIRED_EVIDENCE_ARTIFACTS = Object.freeze({
  "EXT-001": "EXT-001-real-jpyc-payment.md",
  "EXT-002": "EXT-002-wallet-device-launch.md",
  "EXT-003": "EXT-003-public-fqdn-tls.md",
  "EXT-004": "EXT-004-store-ops-drill.md",
  "POC-001": "POC-001.md",
  "POC-002": "POC-002.md",
  "POC-003": "POC-003.md",
  "PERF-001": "PERF-001-scale-soak.md",
});

const REQUIRED_APPROVALS = Object.freeze([
  "legal",
  "aml",
  "privacy",
  "appi",
  "jpyc_contract",
  "confirmation_policy",
  "backscan_policy",
  "refund_treasury",
]);

export const APPROVAL_REQUIRED_SIGNER_ROLE = Object.freeze({
  legal: "legal_accountable",
  aml: "aml_accountable",
  privacy: "privacy_accountable",
  appi: "appi_accountable",
  jpyc_contract: "technology_accountable",
  confirmation_policy: "technology_accountable",
  backscan_policy: "operations_accountable",
  refund_treasury: "operations_accountable",
  limited_pilot_cap: "operations_accountable",
});

const APPROVAL_ENV_BINDINGS = Object.freeze({
  legal: ["LEGAL_GATE_APPROVED", "LEGAL_GATE_APPROVAL_REF"],
  aml: ["AML_POLICY_APPROVED", "AML_POLICY_APPROVAL_REF"],
  privacy: ["PRIVACY_POLICY_APPROVED", "PRIVACY_POLICY_APPROVAL_REF"],
  appi: ["APPI_POLICY_APPROVED", "APPI_POLICY_APPROVAL_REF"],
  jpyc_contract: [null, "JPYC_CONTRACT_APPROVAL_REF"],
  confirmation_policy: [null, "CONFIRMATIONS_POLICY_APPROVAL_REF"],
  backscan_policy: [null, "BACKSCAN_POLICY_APPROVAL_REF"],
  refund_treasury: [null, "REFUND_TREASURY_APPROVAL_REF"],
});

function boolFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validReleaseId(value) {
  const raw = String(value || "").trim();
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
}

function validCommit(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || "").trim());
}

function releaseFingerprint(manifest) {
  return {
    release_id: String(manifest?.release_id || "").trim(),
    commit: String(manifest?.commit || "").trim().toLowerCase(),
    source_hash: String(manifest?.source_hash || "").trim().toLowerCase(),
    app_image_digest: String(manifest?.app_image_digest || "").trim().toLowerCase(),
    environment_id: String(manifest?.environment_id || "").trim(),
  };
}

function validateFingerprint(candidate, expected, prefix) {
  const blockers = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return [`${prefix}_release_fingerprint_missing`];
  }
  if (!validReleaseId(candidate.release_id)) blockers.push(`${prefix}_release_id_invalid`);
  if (!validCommit(candidate.commit)) blockers.push(`${prefix}_commit_invalid`);
  if (!normalizeSha256Hex(candidate.source_hash)) blockers.push(`${prefix}_source_hash_invalid`);
  if (!normalizeSha256Digest(candidate.app_image_digest)) blockers.push(`${prefix}_app_image_digest_invalid`);
  if (!nonEmptyString(candidate.environment_id)) blockers.push(`${prefix}_environment_id_missing`);
  for (const [field, expectedValue] of Object.entries(expected || {})) {
    const actualValue = String(candidate[field] || "").trim().toLowerCase();
    if (actualValue !== String(expectedValue || "").trim().toLowerCase()) {
      blockers.push(`${prefix}_${field}_mismatch`);
    }
  }
  return blockers;
}

function releaseArtifactEntries(releaseManifest) {
  const raw = releaseManifest?.artifact_hashes ?? releaseManifest?.artifacts ?? releaseManifest?.files;
  if (Array.isArray(raw)) {
    return raw.filter((entry) => entry && typeof entry === "object").map((entry) => ({
      field: String(entry.field || entry.name || "").trim(),
      path: String(entry.path || entry.file || entry.relative_path || "").trim(),
      sha256: String(entry.sha256 || entry.hash || "").trim().toLowerCase(),
      media_type: String(entry.media_type || entry.type || "").trim().toLowerCase(),
    }));
  }
  return Object.entries(raw || {}).map(([field, entry]) => ({
    field: String(entry?.field || field).trim(),
    path: String(entry?.path || entry?.file || entry?.relative_path || "").trim(),
    sha256: String(entry?.sha256 || entry?.hash || (typeof entry === "string" ? entry : "")).trim().toLowerCase(),
    media_type: String(entry?.media_type || entry?.type || "").trim().toLowerCase(),
  }));
}

function isWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function loadBoundManifest({
  releaseManifest,
  field,
  schemaVersion,
  evidenceDir,
  root,
  env,
  prefix,
  now,
  signatureOptions,
}) {
  const blockers = [];
  const entries = releaseArtifactEntries(releaseManifest);
  const matches = entries.filter((entry) => entry.field === field);
  if (matches.length !== 1) {
    blockers.push(`${prefix}_release_artifact_entry_count_invalid`);
    return { ok: false, manifest: null, path: null, blockers };
  }
  const entry = matches[0];
  const declared = normalizeSha256Hex(releaseManifest?.[field]);
  if (!declared || normalizeSha256Hex(entry.sha256) !== declared) {
    blockers.push(`${prefix}_release_hash_binding_invalid`);
  }
  if (entry.media_type !== "application/json") blockers.push(`${prefix}_release_media_type_invalid`);

  const safeFile = resolveSafeExistingFile(entry.path, { root });
  if (!safeFile.ok) {
    blockers.push(`${prefix}_file_${safeFile.reason}`);
    return { ok: false, manifest: null, path: null, blockers };
  }
  let evidenceDirReal;
  try {
    evidenceDirReal = fs.realpathSync(evidenceDir);
  } catch (_error) {
    blockers.push(`${prefix}_evidence_dir_unavailable`);
    return { ok: false, manifest: null, path: safeFile.path, blockers };
  }
  if (!isWithin(evidenceDirReal, safeFile.path)) blockers.push(`${prefix}_outside_selected_evidence_dir`);
  if (declared && sha256File(safeFile.path) !== declared) blockers.push(`${prefix}_hash_mismatch`);

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(safeFile.path, "utf8"));
  } catch (_error) {
    blockers.push(`${prefix}_invalid_json`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, manifest: null, path: safeFile.path, blockers };
  }
  if (manifest.schema_version !== schemaVersion) blockers.push(`${prefix}_schema_version_invalid`);
  const signature = verifySignedManifestEnvelope(manifest, env, {
    root,
    blockerPrefix: prefix,
    now,
    ...signatureOptions,
  });
  blockers.push(...signature.blockers);
  return {
    ok: blockers.length === 0,
    manifest,
    path: safeFile.path,
    signature,
    blockers: [...new Set(blockers)],
  };
}

function validateEvidenceArtifacts(manifest, evidenceDir) {
  const blockers = [];
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  const verified = {};
  if (!Array.isArray(manifest?.artifacts)) blockers.push("evidence_manifest_artifacts_not_array");
  for (const [evidenceId, canonicalName] of Object.entries(REQUIRED_EVIDENCE_ARTIFACTS)) {
    const matches = artifacts.filter((entry) => String(entry?.evidence_id || "").trim() === evidenceId);
    if (matches.length !== 1) {
      blockers.push(`evidence_artifact_${evidenceId}_entry_count_invalid`);
      continue;
    }
    const entry = matches[0];
    if (String(entry.path || "").trim() !== canonicalName) blockers.push(`evidence_artifact_${evidenceId}_path_invalid`);
    if (String(entry.media_type || "").trim().toLowerCase() !== "text/markdown") {
      blockers.push(`evidence_artifact_${evidenceId}_media_type_invalid`);
    }
    const expectedHash = normalizeSha256Hex(entry.sha256);
    if (!expectedHash) {
      blockers.push(`evidence_artifact_${evidenceId}_sha256_invalid`);
      continue;
    }
    const safeFile = resolveSafeExistingFile(entry.path, { root: evidenceDir });
    if (!safeFile.ok) {
      blockers.push(`evidence_artifact_${evidenceId}_${safeFile.reason}`);
      continue;
    }
    const actualHash = sha256File(safeFile.path);
    if (actualHash !== expectedHash) blockers.push(`evidence_artifact_${evidenceId}_hash_mismatch`);
    else verified[evidenceId] = { path: safeFile.path, sha256: actualHash };
  }
  const ids = artifacts.map((entry) => String(entry?.evidence_id || "").trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) blockers.push("evidence_manifest_duplicate_artifact_ids");
  return { ok: blockers.length === 0, verified, blockers };
}

function validateApprovalRecord(record, approvalId, env, now, signerContext = {}) {
  const blockers = [];
  const expectedRole = APPROVAL_REQUIRED_SIGNER_ROLE[approvalId];
  if (String(record?.approval_id || "").trim() !== approvalId) blockers.push(`${approvalId}_approval_id_mismatch`);
  if (String(record?.status || "").trim().toLowerCase() !== "approved") blockers.push(`${approvalId}_status_not_approved`);
  for (const field of ["approval_ref", "scope", "approver_id", "approver_role", "approver_key_id", "approved_at", "expires_at", "document_path", "document_sha256"]) {
    if (!nonEmptyString(record?.[field])) blockers.push(`${approvalId}_${field}_missing`);
  }
  if (!expectedRole || String(record?.approver_role || "").trim() !== expectedRole) {
    blockers.push(`${approvalId}_approver_role_mismatch`);
  }
  const approverKeyId = normalizeSha256Hex(record?.approver_key_id);
  if (!approverKeyId) blockers.push(`${approvalId}_approver_key_id_invalid`);
  const signedRoleKeys = signerContext.validSignerKeysByRole?.get(expectedRole) || new Set();
  const releaseRoleKeys = signerContext.allowedSignerKeysByRole?.get(expectedRole) || new Set();
  if (approverKeyId && !signedRoleKeys.has(approverKeyId)) blockers.push(`${approvalId}_approver_key_not_manifest_signer`);
  if (approverKeyId && !releaseRoleKeys.has(approverKeyId)) blockers.push(`${approvalId}_approver_key_not_release_trusted`);
  const approvedAt = Date.parse(String(record?.approved_at || ""));
  const expiresAt = Date.parse(String(record?.expires_at || ""));
  if (!Number.isFinite(approvedAt) || approvedAt > now + 60_000) blockers.push(`${approvalId}_approved_at_invalid`);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) blockers.push(`${approvalId}_expired`);
  if (Number.isFinite(approvedAt) && Number.isFinite(expiresAt)) {
    if (approvedAt >= expiresAt) blockers.push(`${approvalId}_validity_order_invalid`);
    if (expiresAt - approvedAt > APPROVAL_MANIFEST_MAX_VALIDITY_MS) blockers.push(`${approvalId}_validity_window_exceeds_maximum`);
  }
  if (record?.revoked_at != null && String(record.revoked_at).trim() !== "") blockers.push(`${approvalId}_revoked`);
  if (!normalizeSha256Hex(record?.document_sha256)) blockers.push(`${approvalId}_document_sha256_invalid`);

  const [flagKey, refKey] = APPROVAL_ENV_BINDINGS[approvalId] || [];
  if (flagKey && !boolFlag(env[flagKey])) blockers.push(`${approvalId}_${flagKey}_not_enabled`);
  if (refKey && String(record?.approval_ref || "").trim() !== String(env[refKey] || "").trim()) {
    blockers.push(`${approvalId}_${refKey}_mismatch`);
  }
  if (approvalId === "appi") {
    const procedures = record?.procedure_refs;
    for (const key of ["APPI_RETENTION_POLICY_REF", "APPI_DELETION_PROCEDURE_REF", "APPI_DISCLOSURE_PROCEDURE_REF"]) {
      if (String(procedures?.[key] || "").trim() !== String(env[key] || "").trim() || !nonEmptyString(env[key])) {
        blockers.push(`appi_${key}_mismatch`);
      }
    }
  }
  return blockers;
}

function validateApprovalDocuments(approvals, evidenceDir) {
  const blockers = [];
  const verified = {};
  for (const record of approvals) {
    const approvalId = String(record?.approval_id || "unknown").trim();
    const safeFile = resolveSafeExistingFile(record?.document_path, { root: evidenceDir });
    if (!safeFile.ok) {
      blockers.push(`${approvalId}_document_${safeFile.reason}`);
      continue;
    }
    const expected = normalizeSha256Hex(record?.document_sha256);
    if (!expected || sha256File(safeFile.path) !== expected) {
      blockers.push(`${approvalId}_document_hash_mismatch`);
      continue;
    }
    verified[approvalId] = { path: safeFile.path, sha256: expected };
  }
  return { ok: blockers.length === 0, verified, blockers };
}

function validateLimitedPilotCap(approval, env, expectedFingerprint, now, signerContext) {
  const blockers = [];
  if (!approval) return { ok: false, blockers: ["limited_pilot_cap_missing"] };
  blockers.push(...validateApprovalRecord(approval, "limited_pilot_cap", env, now, signerContext));
  blockers.push(...validateFingerprint(approval.release, expectedFingerprint, "limited_pilot_cap"));
  const constraints = approval.constraints;
  const mappings = [
    ["max_total_volume_jpyc_base", "LIMITED_PILOT_MAX_TOTAL_VOLUME_JPYC_BASE"],
    ["max_transaction_amount_jpyc_base", "LIMITED_PILOT_MAX_TRANSACTION_AMOUNT_JPYC_BASE"],
    ["max_transactions", "LIMITED_PILOT_MAX_TRANSACTIONS"],
  ];
  for (const [manifestField, envKey] of mappings) {
    const signedMax = String(constraints?.[manifestField] || "").trim();
    const configured = String(env[envKey] || "").trim();
    if (!/^\d+$/.test(signedMax) || BigInt(signedMax) <= 0n) blockers.push(`limited_pilot_cap_${manifestField}_invalid`);
    if (!/^\d+$/.test(configured) || BigInt(configured) <= 0n) blockers.push(`limited_pilot_cap_${envKey}_invalid`);
    if (/^\d+$/.test(signedMax) && /^\d+$/.test(configured) && BigInt(configured) > BigInt(signedMax)) {
      blockers.push(`limited_pilot_cap_${envKey}_exceeds_signed_maximum`);
    }
  }
  const validFrom = Date.parse(String(constraints?.valid_from || ""));
  const validUntil = Date.parse(String(constraints?.valid_until || ""));
  if (!Number.isFinite(validFrom) || validFrom > now) blockers.push("limited_pilot_cap_not_yet_valid");
  if (!Number.isFinite(validUntil) || validUntil <= now) blockers.push("limited_pilot_cap_window_expired");
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export function validateSignedReleaseEvidence({
  releaseManifestResult,
  evidenceDir,
  env = {},
  root = process.cwd(),
  releaseMode = "commercial",
  now = Date.now(),
} = {}) {
  const blockers = [];
  const releaseManifest = releaseManifestResult?.manifest;
  if (!releaseManifestResult?.ok || !releaseManifest) {
    return {
      ok: false,
      blockers: ["signed_evidence_requires_valid_release_manifest"],
      evidence_manifest: null,
      approval_manifest: null,
      approval_gates: {},
    };
  }
  if (!evidenceDir) {
    return {
      ok: false,
      blockers: ["signed_evidence_requires_explicit_evidence_dir"],
      evidence_manifest: null,
      approval_manifest: null,
      approval_gates: {},
    };
  }
  const expectedFingerprint = releaseFingerprint(releaseManifest);
  blockers.push(...validateReleaseManifestShape(releaseManifest).blockers.map(
    (blocker) => `signed_evidence_${blocker}`,
  ));
  const configuredEnvironmentId = String(env.RELEASE_ENVIRONMENT_ID || "").trim();
  if (!configuredEnvironmentId) blockers.push("release_environment_id_missing");
  if (configuredEnvironmentId
    && configuredEnvironmentId !== String(expectedFingerprint.environment_id || "").trim()) {
    blockers.push("release_environment_id_mismatch");
  }
  const trustPolicy = releaseManifest?.trust_policy;
  if (!trustPolicy || typeof trustPolicy !== "object" || Array.isArray(trustPolicy)) {
    blockers.push("signed_evidence_release_trust_policy_missing");
  }
  const releaseRevokedKeyIds = Array.isArray(trustPolicy?.revoked_key_ids) ? trustPolicy.revoked_key_ids : [];
  const evidenceManifest = loadBoundManifest({
    releaseManifest,
    field: "evidence_manifest_hash",
    schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    evidenceDir,
    root,
    env,
    prefix: "evidence_manifest",
    now,
    signatureOptions: {
      trustedKeyPathsEnv: "EVIDENCE_TRUSTED_PUBLIC_KEY_PATHS",
      revokedKeyIdsEnv: "EVIDENCE_REVOKED_KEY_IDS",
      signerRegistryEnv: "EVIDENCE_SIGNER_REGISTRY_JSON",
      requiredSignerRoles: ["evidence_verifier"],
      additionalRevokedKeyIds: releaseRevokedKeyIds,
      allowedSignerKeyIds: Array.isArray(trustPolicy?.evidence_signer_key_ids)
        ? trustPolicy.evidence_signer_key_ids
        : [],
      maxValidityMs: EVIDENCE_MANIFEST_MAX_VALIDITY_MS,
    },
  });
  const approvalManifest = loadBoundManifest({
    releaseManifest,
    field: "approval_manifest_hash",
    schemaVersion: APPROVAL_MANIFEST_SCHEMA_VERSION,
    evidenceDir,
    root,
    env,
    prefix: "approval_manifest",
    now,
    signatureOptions: {
      trustedKeyPathsEnv: "APPROVAL_TRUSTED_PUBLIC_KEY_PATHS",
      revokedKeyIdsEnv: "APPROVAL_REVOKED_KEY_IDS",
      signerRegistryEnv: "APPROVAL_SIGNER_REGISTRY_JSON",
      requiredSignerRoles: ACCOUNTABLE_SIGNER_ROLES,
      additionalRevokedKeyIds: releaseRevokedKeyIds,
      allowedSignerRoleKeyIds: trustPolicy?.approval_signers || {},
      requireDistinctSignerKeysPerRole: true,
      maxValidityMs: APPROVAL_MANIFEST_MAX_VALIDITY_MS,
    },
  });
  blockers.push(...evidenceManifest.blockers, ...approvalManifest.blockers);

  let evidenceArtifacts = { ok: false, verified: {}, blockers: ["evidence_manifest_unavailable"] };
  if (evidenceManifest.manifest) {
    blockers.push(...validateFingerprint(evidenceManifest.manifest.release, expectedFingerprint, "evidence_manifest"));
    evidenceArtifacts = validateEvidenceArtifacts(evidenceManifest.manifest, evidenceDir);
    blockers.push(...evidenceArtifacts.blockers);
  }

  const approvalGates = {};
  let approvalDocuments = { ok: false, verified: {}, blockers: ["approval_manifest_unavailable"] };
  let limitedPilotCap = { ok: releaseMode !== "limited", blockers: [] };
  if (approvalManifest.manifest) {
    blockers.push(...validateFingerprint(approvalManifest.manifest.release, expectedFingerprint, "approval_manifest"));
    const approvals = Array.isArray(approvalManifest.manifest.approvals) ? approvalManifest.manifest.approvals : [];
    if (!Array.isArray(approvalManifest.manifest.approvals)) blockers.push("approval_manifest_approvals_not_array");
    const approvalIds = approvals.map((record) => String(record?.approval_id || "").trim()).filter(Boolean);
    if (new Set(approvalIds).size !== approvalIds.length) blockers.push("approval_manifest_duplicate_approval_ids");
    const validSignerKeysByRole = new Map();
    for (const signature of approvalManifest.signature?.valid_signatures || []) {
      const keys = validSignerKeysByRole.get(signature.signer_role) || new Set();
      keys.add(signature.key_id);
      validSignerKeysByRole.set(signature.signer_role, keys);
    }
    const allowedSignerKeysByRole = new Map(Object.entries(trustPolicy?.approval_signers || {}).map(
      ([role, keys]) => [role, new Set(Array.isArray(keys) ? keys : [])],
    ));
    const signerContext = { validSignerKeysByRole, allowedSignerKeysByRole };
    for (const approvalId of REQUIRED_APPROVALS) {
      const matches = approvals.filter((record) => String(record?.approval_id || "").trim() === approvalId);
      const errors = matches.length === 1
        ? validateApprovalRecord(matches[0], approvalId, env, now, signerContext)
        : [`${approvalId}_approval_entry_count_invalid`];
      approvalGates[approvalId] = { ok: errors.length === 0, errors };
      blockers.push(...errors);
    }
    approvalDocuments = validateApprovalDocuments(approvals, evidenceDir);
    blockers.push(...approvalDocuments.blockers);
    if (releaseMode === "limited") {
      limitedPilotCap = validateLimitedPilotCap(
        approvals.find((record) => String(record?.approval_id || "").trim() === "limited_pilot_cap"),
        env,
        expectedFingerprint,
        now,
        signerContext,
      );
      blockers.push(...limitedPilotCap.blockers);
    }
  }

  return {
    ok: blockers.length === 0,
    release_fingerprint: expectedFingerprint,
    evidence_manifest: evidenceManifest,
    approval_manifest: approvalManifest,
    evidence_artifacts: evidenceArtifacts,
    approval_documents: approvalDocuments,
    approval_gates: approvalGates,
    limited_pilot_cap: limitedPilotCap,
    blockers: [...new Set(blockers)],
  };
}

export function evaluateReleaseBoundApproval({
  releaseManifestResult,
  signedEvidence,
  approvalId,
} = {}) {
  const normalizedApprovalId = String(approvalId || "").trim();
  const blockers = [];
  if (!APPROVAL_REQUIRED_SIGNER_ROLE[normalizedApprovalId]) {
    blockers.push("approval_id_invalid");
  }
  if (!releaseManifestResult?.ok || !releaseManifestResult?.manifest) {
    blockers.push("release_manifest_invalid");
  }
  if (!signedEvidence?.approval_manifest?.ok) {
    blockers.push("approval_manifest_invalid");
  }
  for (const blocker of signedEvidence?.blockers || []) {
    const code = String(blocker || "").trim();
    if (code.startsWith("approval_manifest_") || code.startsWith("release_environment_id_")) {
      blockers.push(code);
    }
  }
  const approvalGate = signedEvidence?.approval_gates?.[normalizedApprovalId];
  if (!approvalGate?.ok) {
    blockers.push(...(
      Array.isArray(approvalGate?.errors) && approvalGate.errors.length > 0
        ? approvalGate.errors
        : [`${normalizedApprovalId || "unknown"}_approval_missing_or_invalid`]
    ));
  }
  if (!signedEvidence?.approval_documents?.verified?.[normalizedApprovalId]) {
    blockers.push(`${normalizedApprovalId || "unknown"}_approval_document_unverified`);
  }
  return {
    ok: blockers.length === 0,
    approval_id: normalizedApprovalId || null,
    source: "release_bound_signed_manifest",
    blockers: [...new Set(blockers)],
  };
}
