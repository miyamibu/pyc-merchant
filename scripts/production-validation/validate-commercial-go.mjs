#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scaleToDecimals } from "../../src/amounts.mjs";
import {
  evaluatePolicyPublicationSource,
  unavailablePolicyPublication,
} from "../../src/policy-publication.mjs";
import { validateCommercialEvidence } from "./validate-commercial-evidence.mjs";
import { renderCommercialScorecard } from "./validate-commercial-scorecard.mjs";
import {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_MANIFEST_MAX_VALIDITY_MS,
  resolveSafeExistingFile,
  validateManifestValidityWindow,
  validateReleaseManifestShape,
  verifySignedManifestEnvelope,
  verifyReleaseImageReferenceContract,
} from "./release-identity.mjs";
import { validateSignedReleaseEvidence } from "./signed-release-evidence.mjs";
import {
  APPROVED_LEDGER_BASE_UNIT_SCALE,
  APPROVED_TOKEN_DECIMALS,
} from "../../src/token-metadata.mjs";

const DEFAULT_EVIDENCE_ROOT = path.resolve(process.cwd(), "docs/production/evidence");

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

function boolFlag(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function loadEnvMap(envFilePath) {
  const env = { ...process.env };
  if (!envFilePath) return env;
  const resolved = path.resolve(process.cwd(), envFilePath);
  if (!fs.existsSync(resolved)) return env;
  for (const line of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value && env[key] == null) env[key] = value;
  }
  return env;
}

const PLACEHOLDER_WORDS = [
  "placeholder",
  "replace",
  "example",
  "sample",
  "todo",
  "tbd",
  "pending",
  "change-me",
  "default",
];

function isPlaceholderLike(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return true;
  return PLACEHOLDER_WORDS.some((word) => raw === word || raw.includes(word));
}

function isStrongSecret(value) {
  const raw = String(value || "");
  if (raw.length < 32) return false;
  const lowered = raw.toLowerCase();
  if (PLACEHOLDER_WORDS.some((word) => lowered.includes(word))) return false;
  return true;
}

function evaluatePolicyUrls({ sourcePath }) {
  const resolvedPath = path.resolve(process.cwd(), sourcePath || "public/mobile.js");
  if (!fs.existsSync(resolvedPath)) {
    return unavailablePolicyPublication({ sourcePath: resolvedPath, message: "missing_policy_urls_source_file" });
  }

  const content = fs.readFileSync(resolvedPath, "utf8");
  return evaluatePolicyPublicationSource(content, { sourcePath: resolvedPath });
}

function utcTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function parseScaleDecimals(scale) {
  try {
    return scaleToDecimals(String(scale || ""));
  } catch (_error) {
    return null;
  }
}

function runAuditChainVerification(env) {
  const dbPath = path.resolve(process.cwd(), env.DB_PATH || "./data/app.db");
  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      status: "missing_db",
      message: `DB_PATH not found: ${dbPath}`,
      db_path: dbPath,
    };
  }
  const run = spawnSync(process.execPath, ["scripts/verify-audit-chain.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, DB_PATH: dbPath },
    encoding: "utf8",
  });
  let parsed = null;
  if (run.stdout) {
    try {
      parsed = JSON.parse(run.stdout);
    } catch {
      parsed = null;
    }
  }
  return {
    ok: run.status === 0 && parsed?.ok === true,
    status: run.status === 0 ? "pass" : "fail",
    db_path: dbPath,
    output: parsed,
    stderr: String(run.stderr || "").trim() || null,
  };
}

function validateReleaseId(value) {
  const raw = String(value || "").trim();
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
}

export function verifyManifestArtifacts(manifest, { root = process.cwd() } = {}) {
  const rawEntries = manifest?.artifact_hashes ?? manifest?.artifacts ?? manifest?.files;
  const entries = Array.isArray(rawEntries)
    ? rawEntries.filter((entry) => entry && typeof entry === "object").map((entry) => ({
      field: String(entry.field || entry.name || "").trim(),
      path: String(entry.path || entry.file || entry.relative_path || "").trim(),
      expected: String(entry.sha256 || entry.hash || "").trim().toLowerCase(),
      artifactType: String(entry.artifact_type || "").trim().toLowerCase(),
      mediaType: String(entry.media_type || entry.type || "").trim().toLowerCase(),
    }))
    : Object.entries(rawEntries || {}).map(([field, entry]) => ({
      field: String(entry?.field || field).trim(),
      path: String(entry?.path || entry?.file || entry?.relative_path || (typeof entry === "string" ? field : "")).trim(),
      expected: String(entry?.sha256 || entry?.hash || (typeof entry === "string" ? entry : "")).trim().toLowerCase(),
      artifactType: String(entry?.artifact_type || "").trim().toLowerCase(),
      mediaType: String(entry?.media_type || entry?.type || "").trim().toLowerCase(),
    }));
  const blockers = [];
  const verifiedFields = [];
  const artifactContracts = {
    source_hash: { artifactType: "source_archive", path: /(?:^|\/)source(?:[-_.][^/]*)?\.(?:tar|tar\.gz|tgz)$/i, mediaTypes: ["application/x-tar", "application/gzip"] },
    lockfile_hash: { artifactType: "npm_lockfile", path: /(?:^|\/)package-lock\.json$/i, mediaTypes: ["application/json"] },
    migration_hash: { artifactType: "migration_bundle", path: /(?:^|\/)migrations?(?:[-_.][^/]*)?\.(?:tar|tar\.gz|tgz|json|txt)$/i, mediaTypes: ["application/x-tar", "application/gzip", "application/json", "text/plain"] },
    env_hash: { artifactType: "nonsecret_environment", path: /(?:^|\/)(?:production[-_.])?env(?:[-_.][^/]*)?\.(?:json|txt|env)$/i, mediaTypes: ["application/json", "text/plain"] },
    db_snapshot_hash: { artifactType: "database_snapshot", path: /(?:^|\/)db[-_.]snapshot(?:[-_.][^/]*)?\.(?:db|sqlite|sqlite3)$/i, mediaTypes: ["application/vnd.sqlite3", "application/octet-stream"] },
    backup_hash: { artifactType: "backup_archive", path: /(?:^|\/)backup(?:[-_.][^/]*)?\.(?:tar|tar\.gz|tgz|zip)$/i, mediaTypes: ["application/x-tar", "application/gzip", "application/zip"] },
  };
  for (const [field, contract] of Object.entries(artifactContracts)) {
    const declared = String(manifest?.[field] || "").trim().toLowerCase();
    const matchingEntries = entries.filter((candidate) => candidate.field === field);
    const entry = matchingEntries[0];
    if (matchingEntries.length !== 1) blockers.push(`manifest_artifact_entry_count_invalid_${field}`);
    if (!declared || !entry?.path || entry.expected !== declared) {
      blockers.push(`manifest_hash_unverifiable_${field}`);
      continue;
    }
    if (entry.artifactType !== contract.artifactType) blockers.push(`manifest_artifact_type_mismatch_${field}`);
    if (!contract.mediaTypes.includes(entry.mediaType)) blockers.push(`manifest_artifact_media_type_mismatch_${field}`);
    if (!contract.path.test(entry.path)) blockers.push(`manifest_artifact_path_mismatch_${field}`);
    const artifactPath = resolveSafeExistingFile(entry.path, { root });
    if (!artifactPath.ok) {
      const suffix = artifactPath.reason === "missing" ? "missing" : `unsafe_${artifactPath.reason}`;
      blockers.push(`manifest_artifact_${suffix}_${field}`);
      continue;
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(artifactPath.path)).digest("hex");
    if (actual !== declared) blockers.push(`manifest_artifact_hash_mismatch_${field}`);
    else verifiedFields.push(field);
  }
  return { ok: blockers.length === 0, verified_fields: verifiedFields, blockers };
}

function verifyManifestSignatures(manifest, env = {}, { root = process.cwd() } = {}) {
  const result = verifySignedManifestEnvelope(manifest, env, {
    root,
    blockerPrefix: "manifest",
    signerRegistryEnv: "RELEASE_SIGNER_REGISTRY_JSON",
    requiredSignerRoles: ["release_authority"],
    additionalRevokedKeyIds: manifest?.trust_policy?.revoked_key_ids || [],
    allowedSignerKeyIds: manifest?.trust_policy?.release_signer_key_ids || [],
    maxValidityMs: RELEASE_MANIFEST_MAX_VALIDITY_MS,
  });
  const allowedReleaseKeys = new Set(manifest?.trust_policy?.release_signer_key_ids || []);
  if (!result.valid_signatures.some((entry) => (
    entry.signer_role === "release_authority" && allowedReleaseKeys.has(entry.key_id)
  ))) {
    result.blockers.push("manifest_release_authority_not_bound_by_trust_policy");
    result.ok = false;
  }
  result.blockers = [...new Set(result.blockers)];
  return result;
}

export function loadReleaseManifest(manifestPath, env = {}, { root = process.cwd() } = {}) {
  if (!manifestPath) return { ok: false, path: null, blockers: ["missing_release_manifest"] };
  const manifestFile = resolveSafeExistingFile(manifestPath, { root });
  if (!manifestFile.ok) {
    const blocker = manifestFile.reason === "missing"
      ? "missing_release_manifest"
      : `unsafe_release_manifest_path_${manifestFile.reason}`;
    return { ok: false, path: null, blockers: [blocker] };
  }
  const resolved = manifestFile.path;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (_error) {
    return { ok: false, path: resolved, blockers: ["invalid_release_manifest_json"] };
  }

  const required = [
    "schema_version",
    "release_id",
    "mode",
    "commit",
    "source_hash",
    "lockfile_hash",
    "migration_hash",
    "runtime",
    "base_image_digest",
    "app_image_digest",
    "nginx_image_digest",
    "env_hash",
    "db_snapshot_hash",
    "backup_hash",
    "audit_root",
    "environment_id",
    "evidence_manifest_hash",
    "approval_manifest_hash",
    "issued_at",
    "expires_at",
    "revocation_status",
    "signatures",
    "trust_policy",
  ];
  const blockers = [];
  for (const key of required) {
    if (manifest[key] == null || manifest[key] === "" || String(manifest[key]).toLowerCase() === "null") {
      blockers.push(`manifest_missing_${key}`);
    }
  }
  if (manifest.schema_version !== RELEASE_MANIFEST_SCHEMA_VERSION) blockers.push("manifest_schema_version_invalid");
  blockers.push(...validateReleaseManifestShape(manifest).blockers);
  if (String(manifest.app_image_digest || "").trim().toLowerCase() === "null") blockers.push("manifest_app_image_digest_null");
  if (String(manifest.base_image_digest || "").trim().toLowerCase() === "null") blockers.push("manifest_base_image_digest_null");
  const configuredEnvironmentId = String(env.RELEASE_ENVIRONMENT_ID || "").trim();
  if (!configuredEnvironmentId) blockers.push("manifest_release_environment_id_missing");
  if (configuredEnvironmentId && String(manifest.environment_id || "").trim() !== configuredEnvironmentId) {
    blockers.push("manifest_release_environment_id_mismatch");
  }
  const imageReferenceVerification = verifyReleaseImageReferenceContract({
    manifest,
    appImageRef: env.APP_IMAGE_REF,
    nginxImageRef: env.NGINX_IMAGE_REF,
  });
  blockers.push(...imageReferenceVerification.blockers);
  if (!Array.isArray(manifest.signatures) || manifest.signatures.length === 0) blockers.push("manifest_missing_signatures");
  if (String(manifest.revocation_status || "").trim().toLowerCase() !== "valid") blockers.push("manifest_revocation_not_valid");
  const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout?.trim() || "";
  const currentTree = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).stdout?.trim() || "";
  if (currentCommit && String(manifest.commit || "").trim() !== currentCommit) blockers.push("manifest_commit_mismatch_current_HEAD");
  if (currentTree) blockers.push("manifest_requires_clean_worktree");
  blockers.push(...validateManifestValidityWindow(manifest, {
    blockerPrefix: "manifest",
    maxValidityMs: RELEASE_MANIFEST_MAX_VALIDITY_MS,
  }).blockers);
  const artifactVerification = verifyManifestArtifacts(manifest, { root });
  const signatureVerification = verifyManifestSignatures(manifest, env, { root });
  blockers.push(...artifactVerification.blockers, ...signatureVerification.blockers);
  return {
    ok: blockers.length === 0,
    path: resolved,
    manifest,
    blockers: [...new Set(blockers)],
    image_reference_verification: imageReferenceVerification,
    artifact_verification: artifactVerification,
    signature_verification: signatureVerification,
  };
}

function evaluateDangerousFlags(env) {
  const blockers = [];
  const simulation = boolFlag(env.ENABLE_PUBLIC_PAYMENT_SIMULATION, false);
  const demoControls = boolFlag(env.DEMO_CONTROLS_ENABLED, false);
  const diagnosticMode = boolFlag(env.DIAGNOSTIC_MODE_ENABLED, false);
  const manualIngest = boolFlag(env.ALLOW_MANUAL_PAYMENT_INGEST, false);
  const walletAdapterType = String(env.WALLET_ADAPTER_TYPE || "mock").trim().toLowerCase();
  const corsOrigins = String(env.CORS_ALLOW_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const trustProxy = boolFlag(env.TRUST_PROXY, true);

  if (simulation) blockers.push("ENABLE_PUBLIC_PAYMENT_SIMULATION must be false");
  if (demoControls) blockers.push("DEMO_CONTROLS_ENABLED must be false");
  if (diagnosticMode) blockers.push("DIAGNOSTIC_MODE_ENABLED must be false");
  if (manualIngest && isPlaceholderLike(env.MANUAL_INGEST_APPROVAL_REF)) {
    blockers.push("ALLOW_MANUAL_PAYMENT_INGEST requires MANUAL_INGEST_APPROVAL_REF");
  }
  if (!["wallet_deeplink", "hashport_deeplink"].includes(walletAdapterType)) {
    blockers.push("WALLET_ADAPTER_TYPE must be a configured wallet deeplink adapter");
  }
  if (!String(env.WALLET_DEEPLINK_TEMPLATE || env.HASHPORT_WALLET_DEEPLINK_TEMPLATE || "").trim()) {
    blockers.push("a reviewed wallet deeplink template is required");
  }
  const enabledChains = String(env.ENABLED_PAYMENT_CHAIN_IDS || env.CHAIN_ID || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (enabledChains.length > 1) {
    blockers.push("multi-chain production-like issuance requires an approved per-chain policy and credential registry");
  }
  if (!isStrongSecret(env.APP_SECRET)) blockers.push("APP_SECRET is weak/default");
  if (!isStrongSecret(env.SERVICE_INGEST_SECRET)) blockers.push("SERVICE_INGEST_SECRET is weak/default");
  if (!isStrongSecret(env.METRICS_SECRET)) blockers.push("METRICS_SECRET is weak/default");
  if (corsOrigins.length === 0) blockers.push("CORS_ALLOW_ORIGINS must not be empty");
  if (corsOrigins.some((origin) => origin === "*" || origin.includes("*"))) blockers.push("CORS_ALLOW_ORIGINS wildcard is not allowed");
  if (!trustProxy) blockers.push("TRUST_PROXY must be enabled");

  const sessionTtl = Number(env.SESSION_TTL_SEC || 43200);
  const sseTtl = Number(env.SSE_TOKEN_MAX_TTL_SEC || 900);
  const pinAttempts = Number(env.PIN_LOCKOUT_MAX_ATTEMPTS || 5);
  const pinLockoutSec = Number(env.PIN_LOCKOUT_SEC || 900);
  const replayTtl = Number(env.SERVICE_REPLAY_GUARD_TTL_SEC || 86400);
  const idemTtl = Number(env.IDEMPOTENCY_TTL_SEC || 604800);
  const publicRateLimit = Number(env.PUBLIC_RATE_LIMIT_MAX || 30);
  const loginRateLimit = Number(env.LOGIN_RATE_LIMIT_MAX || 10);

  if (!Number.isFinite(sessionTtl) || sessionTtl <= 0) blockers.push("SESSION_TTL_SEC must be > 0");
  if (!Number.isFinite(sseTtl) || sseTtl < 60 || sseTtl > 900) blockers.push("SSE_TOKEN_MAX_TTL_SEC must be between 60 and 900");
  if (!Number.isFinite(pinAttempts) || pinAttempts < 1) blockers.push("PIN_LOCKOUT_MAX_ATTEMPTS must be >= 1");
  if (!Number.isFinite(pinLockoutSec) || pinLockoutSec < 1) blockers.push("PIN_LOCKOUT_SEC must be >= 1");
  if (!Number.isFinite(replayTtl) || replayTtl < 1) blockers.push("SERVICE_REPLAY_GUARD_TTL_SEC must be >= 1");
  if (!Number.isFinite(idemTtl) || idemTtl < 1) blockers.push("IDEMPOTENCY_TTL_SEC must be >= 1");
  if (!Number.isFinite(publicRateLimit) || publicRateLimit < 1) blockers.push("PUBLIC_RATE_LIMIT_MAX must be >= 1");
  if (!Number.isFinite(loginRateLimit) || loginRateLimit < 1) blockers.push("LOGIN_RATE_LIMIT_MAX must be >= 1");

  return { ok: blockers.length === 0, blockers };
}

function evaluateCommercialGo({ env, evidenceRoot, policyUrlSource }) {
  const appEnv = String(env.APP_ENV || env.NODE_ENV || "development").trim().toLowerCase();
  const commercialMode = boolFlag(env.COMMERCIAL_GO_MODE, appEnv === "production");
  const releaseMode = String(env.RELEASE_MODE || env.COMMERCIAL_RELEASE_MODE || (commercialMode ? "commercial" : "development")).trim().toLowerCase();
  const releaseId = String(env.RELEASE_ID || "").trim();
  const evidenceDir = String(env.COMMERCIAL_EVIDENCE_DIR || "").trim();
  const manifestPath = String(env.RELEASE_MANIFEST || "").trim();
  const releaseManifest = loadReleaseManifest(manifestPath, env);
  if (releaseManifest.manifest && releaseId && String(releaseManifest.manifest.release_id || "").trim() !== releaseId) {
    releaseManifest.blockers.push("manifest_release_id_mismatch_selected_release");
    releaseManifest.ok = false;
  }
  const explicitReleaseSelectionGate = validateReleaseId(releaseId) && Boolean(evidenceDir) && Boolean(manifestPath);
  const releaseModeGate = ["limited", "commercial"].includes(releaseMode)
    && String(releaseManifest.manifest?.mode || "").trim().toLowerCase() === releaseMode;
  const chainId = String(env.CHAIN_ID || "").trim();
  const tokenContract = String(env.TOKEN_CONTRACT || "").trim().toLowerCase();
  const approvedTokenContract = String(env.APPROVED_JPYC_TOKEN_CONTRACT || "").trim().toLowerCase();
  const tokenDecimals = Number(env.TOKEN_DECIMALS || NaN);
  const ledgerBaseUnitScale = env.LEDGER_BASE_UNIT_SCALE || env.JPYC_BASE_UNIT_SCALE;
  const scaleDecimals = parseScaleDecimals(ledgerBaseUnitScale);
  const configuredLedgerDecimals = env.LEDGER_DECIMALS == null || String(env.LEDGER_DECIMALS).trim() === ""
    ? null
    : Number(env.LEDGER_DECIMALS);
  const approvedTokenName = String(env.APPROVED_TOKEN_NAME || "").trim();
  const approvedTokenCodeHash = String(env.APPROVED_TOKEN_CODE_HASH || "").trim().toLowerCase();
  const approvedImplementationCodeHash = String(env.APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH || "").trim().toLowerCase();
  const tokenMetadataApprovalPinsGate = Boolean(approvedTokenName)
    && /^0x[0-9a-f]{64}$/.test(approvedTokenCodeHash)
    && /^0x[0-9a-f]{64}$/.test(approvedImplementationCodeHash);

  const jpycConfigurationGate = chainId === "137"
    && !!approvedTokenContract
    && tokenContract === approvedTokenContract
    && Number.isFinite(tokenDecimals)
    && scaleDecimals != null
    && tokenDecimals === APPROVED_TOKEN_DECIMALS
    && String(ledgerBaseUnitScale || "").trim() === APPROVED_LEDGER_BASE_UNIT_SCALE
    && (configuredLedgerDecimals == null || configuredLedgerDecimals === scaleDecimals)
    && tokenMetadataApprovalPinsGate;

  const requiredConfirmations = Number(env.REQUIRED_CONFIRMATIONS || 2);
  const minRequiredConfirmations = Number(env.MIN_REQUIRED_CONFIRMATIONS || 2);
  const backscanBlocks = Number(env.MONITOR_BACKSCAN_BLOCKS || 12);
  const minBackscanBlocks = Number(env.MIN_MONITOR_BACKSCAN_BLOCKS || 12);

  const confirmationConfigurationGate = Number.isFinite(requiredConfirmations)
    && Number.isFinite(minRequiredConfirmations)
    && requiredConfirmations >= minRequiredConfirmations;

  const backscanConfigurationGate = Number.isFinite(backscanBlocks)
    && Number.isFinite(minBackscanBlocks)
    && backscanBlocks >= minBackscanBlocks;

  const settlementPolicy = String(env.SETTLEMENT_UNRESOLVED_REVIEW_POLICY || "").trim().toLowerCase();
  const settlementBlockLegacy = boolFlag(env.SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS, false);
  const settlementPolicyGate = settlementPolicy === "block" || settlementBlockLegacy;

  const refundPolicyGate = boolFlag(env.REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR, true);
  const policyUrls = evaluatePolicyUrls({ sourcePath: policyUrlSource || env.POLICY_URL_SOURCE || "public/mobile.js" });
  const dangerousFlags = evaluateDangerousFlags(env);
  const bindHost = String(env.APP_BIND_HOST || "").trim();
  const trustProxy = boolFlag(env.TRUST_PROXY, false);
  const trustProxyHops = String(env.TRUST_PROXY_HOPS || "").trim();
  const trustProxyCidrs = String(env.TRUST_PROXY_CIDRS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const proxyBoundaryBlockers = [];
  if (appEnv === "production" && !bindHost) proxyBoundaryBlockers.push("APP_BIND_HOST must be explicit in production");
  if (appEnv === "production" && !trustProxy) proxyBoundaryBlockers.push("TRUST_PROXY must be enabled in production");
  if (appEnv === "production" && trustProxy && !/^\d+$/.test(trustProxyHops) && trustProxyCidrs.length === 0) {
    proxyBoundaryBlockers.push("production TRUST_PROXY requires TRUST_PROXY_HOPS or TRUST_PROXY_CIDRS");
  }
  const auditChain = runAuditChainVerification(env);
  const evidence = validateCommercialEvidence({ evidenceRoot, evidenceDir: evidenceDir || null });
  const signedReleaseEvidence = validateSignedReleaseEvidence({
    releaseManifestResult: releaseManifest,
    evidenceDir: evidenceDir || null,
    env,
    releaseMode,
  });
  const signedApproval = (approvalId) => Boolean(signedReleaseEvidence.approval_gates?.[approvalId]?.ok);
  const legalGate = signedApproval("legal");
  const amlGate = signedApproval("aml");
  const privacyGate = signedApproval("privacy");
  const appiGate = signedApproval("appi");
  const jpycContractGate = jpycConfigurationGate && signedApproval("jpyc_contract");
  const confirmationPolicyGate = confirmationConfigurationGate && signedApproval("confirmation_policy");
  const backscanPolicyGate = backscanConfigurationGate && signedApproval("backscan_policy");
  const signedConditionalWaiverRef = String(env.SIGNED_CONDITIONAL_GO_WAIVER_REF || "").trim();

  const gates = {
    production_env_gate: appEnv === "production",
    commercial_go_mode_gate: commercialMode,
    legal_gate: legalGate,
    aml_gate: amlGate,
    privacy_gate: privacyGate,
    appi_gate: appiGate,
    jpyc_contract_gate: jpycContractGate,
    token_metadata_approval_pins_gate: tokenMetadataApprovalPinsGate,
    confirmation_policy_gate: confirmationPolicyGate,
    backscan_policy_gate: backscanPolicyGate,
    dangerous_flags_gate: dangerousFlags.ok,
    audit_chain_gate: auditChain.ok,
    refund_policy_gate: refundPolicyGate,
    settlement_policy_gate: settlementPolicyGate,
    policy_urls_gate: policyUrls.ok,
    explicit_release_selection_gate: explicitReleaseSelectionGate,
    release_mode_gate: releaseModeGate,
    release_manifest_gate: releaseManifest.ok,
    evidence_manifest_gate: Boolean(signedReleaseEvidence.evidence_manifest?.ok),
    approval_manifest_gate: Boolean(signedReleaseEvidence.approval_manifest?.ok),
    release_evidence_binding_gate: signedReleaseEvidence.ok,
    limited_pilot_cap_gate: releaseMode !== "limited" || Boolean(signedReleaseEvidence.limited_pilot_cap?.ok),
    refund_treasury_approval_gate: signedApproval("refund_treasury"),
    wallet_evidence_gate: Boolean(evidence.ext?.EXT_002?.ok),
    real_payment_evidence_gate: Boolean(evidence.ext?.EXT_001?.ok),
    tls_evidence_gate: Boolean(evidence.ext?.EXT_003?.ok),
    store_ops_drill_gate: Boolean(evidence.ext?.EXT_004?.ok),
    poc_package_gate: Boolean(evidence.poc_all_pass),
    performance_evidence_gate: Boolean(evidence.performance_pass),
  };

  const blockers = { P0: [], P1: [], P2: [] };
  const releaseGateRequired = appEnv === "production"
    || ["pilot", "commercial"].includes(String(env.DEPLOYMENT_STAGE || "").trim().toLowerCase())
    || commercialMode;
  if (releaseGateRequired && !/^0x[0-9a-fA-F]{40}$/.test(String(env.REFUND_TREASURY_ADDRESS || "").trim())) {
    blockers.P0.push("REFUND_TREASURY_ADDRESS must be a configured EVM address for production-like refund verification");
  }
  if (releaseGateRequired && /^(?:|replace|todo|tbd|example|dummy|changeme)$/i.test(String(env.REFUND_TREASURY_APPROVAL_REF || "").trim())) {
    blockers.P0.push("REFUND_TREASURY_APPROVAL_REF must identify the approved store/chain treasury");
  }

  if (!gates.legal_gate) blockers.P0.push("missing legal approval gate/reference");
  if (!gates.aml_gate) blockers.P0.push("missing AML approval gate/reference");
  if (!gates.privacy_gate) blockers.P0.push("missing privacy approval gate/reference");
  if (!gates.appi_gate) blockers.P0.push("missing APPI approval gate/reference");
  if (!gates.jpyc_contract_gate) blockers.P0.push("JPYC contract gate failed (chain/contract/ref/decimals/ledger-scale/metadata-pin mismatch)");
  if (!gates.confirmation_policy_gate) blockers.P0.push("confirmation policy gate failed");
  if (!gates.backscan_policy_gate) blockers.P0.push("backscan policy gate failed");
  if (!gates.dangerous_flags_gate) blockers.P0.push(...dangerousFlags.blockers);
  blockers.P0.push(...proxyBoundaryBlockers);
  if (!gates.audit_chain_gate) blockers.P0.push(`audit hash-chain verification failed: ${auditChain.message || auditChain.status}`);
  if (!gates.refund_policy_gate) blockers.P0.push("REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR must be true");
  if (!gates.settlement_policy_gate) blockers.P0.push("settlement_unresolved_review_policy must be block in commercial mode");
  if (!gates.explicit_release_selection_gate) blockers.P0.push("release gate requires explicit --release-id, --evidence-dir, and --manifest");
  if (!gates.release_mode_gate) blockers.P0.push("release mode must be limited/commercial and match the signed release manifest");
  if (!gates.release_manifest_gate) blockers.P0.push(...releaseManifest.blockers);
  if (!gates.release_evidence_binding_gate) blockers.P0.push(...signedReleaseEvidence.blockers);
  if (!gates.refund_treasury_approval_gate) blockers.P0.push("refund treasury approval is not present in the signed approval manifest");
  if (!gates.limited_pilot_cap_gate) blockers.P0.push("limited pilot limits are not bounded by a signed release-scoped maximum");
  if (evidence.evidence_dir_selection !== "explicit") blockers.P0.push("latest evidence auto-selection is forbidden for real-money release gates");
  if (signedConditionalWaiverRef) blockers.P0.push("real-money release mode forbids conditional waivers");

  if (!gates.production_env_gate) blockers.P1.push("APP_ENV is not production");
  if (!gates.commercial_go_mode_gate) blockers.P1.push("COMMERCIAL_GO_MODE is not enabled");
  if (!gates.policy_urls_gate) blockers.P1.push("customer policy URLs and published versions are not fully configured");
  if (!gates.wallet_evidence_gate) blockers.P1.push("EXT-002 wallet/device evidence is not pass");
  if (!gates.real_payment_evidence_gate) blockers.P1.push("EXT-001 real JPYC evidence is not pass");
  if (!gates.tls_evidence_gate) blockers.P1.push("EXT-003 TLS evidence is not pass");
  if (!gates.store_ops_drill_gate) blockers.P1.push("EXT-004 non-crypto staff drill is not pass");

  if (!gates.poc_package_gate) blockers.P2.push("POC-001..003 KPI evidence not fully pass");
  if (!gates.performance_evidence_gate) blockers.P2.push("PERF-001 scale/performance/soak evidence is not pass");

  const weights = {
    production_env_gate: 0.5,
    commercial_go_mode_gate: 0.5,
    legal_gate: 0.5,
    aml_gate: 0.5,
    privacy_gate: 0.5,
    appi_gate: 0.5,
    jpyc_contract_gate: 0.5,
    confirmation_policy_gate: 0.5,
    backscan_policy_gate: 0.5,
    dangerous_flags_gate: 0.5,
    audit_chain_gate: 0.5,
    refund_policy_gate: 0.5,
    settlement_policy_gate: 0.5,
    policy_urls_gate: 0.4,
    wallet_evidence_gate: 0.6,
    real_payment_evidence_gate: 0.6,
    tls_evidence_gate: 0.6,
    store_ops_drill_gate: 0.6,
    poc_package_gate: 1.1,
    performance_evidence_gate: 0.5,
  };

  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (gates[key]) score += weight;
  }
  score = Math.max(0, Math.min(10, Number(score.toFixed(1))));

  const allBlockerCount = blockers.P0.length + blockers.P1.length + blockers.P2.length;
  const extAllPass = gates.wallet_evidence_gate && gates.real_payment_evidence_gate && gates.tls_evidence_gate && gates.store_ops_drill_gate;

  let verdict = "NO_GO";
  if (allBlockerCount > 0) {
    verdict = "NO_GO";
  } else if (releaseMode === "commercial" && gates.production_env_gate && gates.commercial_go_mode_gate && gates.policy_urls_gate && extAllPass && gates.poc_package_gate && gates.performance_evidence_gate) {
    verdict = "COMMERCIAL_GO_10";
  } else if (releaseMode === "limited" && gates.limited_pilot_cap_gate && gates.release_evidence_binding_gate) {
    verdict = "LIMITED_PILOT_GO";
  }

  return {
    generated_at: new Date().toISOString(),
    app_env: appEnv,
    commercial_go_mode: commercialMode,
    release_mode: releaseMode,
    release_id: releaseId || null,
    release_manifest: releaseManifest.path,
    evidence_root: evidenceRoot,
    evidence_dir: evidence.evidence_dir || null,
    evidence_dir_selection: evidence.evidence_dir_selection,
    latest_evidence_dir: evidence.latest_evidence_dir || null,
    score,
    verdict,
    commercial_9_ready: verdict === "COMMERCIAL_GO_10",
    commercial_10_ready: verdict === "COMMERCIAL_GO_10",
    gates,
    blockers,
    dangerous_flag_details: dangerousFlags.blockers,
    audit_chain: auditChain,
    policy_urls: policyUrls,
    release_manifest_gate: releaseManifest,
    signed_release_evidence: signedReleaseEvidence,
    external_evidence: evidence.ext,
    poc_evidence: evidence.poc,
    ext_all_pass: evidence.ext_all_pass,
    poc_all_pass: evidence.poc_all_pass,
    performance_evidence: evidence.performance,
    performance_pass: evidence.performance_pass,
  };
}

function renderSummaryMarkdown(report, paths) {
  const lines = [];
  lines.push("# Commercial Go Validation Summary");
  lines.push("");
  lines.push(`- Generated at: ${report.generated_at}`);
  lines.push(`- Verdict: ${report.verdict}`);
  lines.push(`- Score: ${Number(report.score).toFixed(1)} / 10`);
  lines.push(`- JSON: ${paths.json}`);
  lines.push(`- Scorecard: ${paths.scorecard}`);
  lines.push("");
  lines.push("## P0 blockers");
  lines.push("");
  if ((report.blockers?.P0 || []).length === 0) {
    lines.push("- none");
  } else {
    for (const row of report.blockers.P0) lines.push(`- ${row}`);
  }
  lines.push("");
  lines.push("## Policy URLs");
  lines.push("");
  lines.push(`- source: ${report.policy_urls?.source_path || "unknown"}`);
  lines.push(`- gate: ${report.gates?.policy_urls_gate ? "pass" : "fail"}`);
  if ((report.policy_urls?.missing_keys || []).length > 0) {
    lines.push(`- missing or invalid: ${report.policy_urls.missing_keys.join(", ")}`);
  }
  if ((report.policy_urls?.missing_version_keys || []).length > 0) {
    lines.push(`- missing or invalid versions: ${report.policy_urls.missing_version_keys.join(", ")}`);
  }
  lines.push("");
  lines.push("## External evidence");
  lines.push("");
  for (const key of ["EXT_001", "EXT_002", "EXT_003", "EXT_004"]) {
    const row = report.external_evidence?.[key] || {};
    lines.push(`- ${key}: ${row.status || "missing"} (${row.file || "file missing"})`);
  }
  lines.push("");
  lines.push("## PoC evidence");
  lines.push("");
  for (const row of report.poc_evidence || []) {
    lines.push(`- ${row.id}: ${row.status || "missing"}`);
  }
  if (!report.poc_evidence || report.poc_evidence.length === 0) {
    lines.push("- POC-001..003 evidence not found");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedEnv = loadEnvMap(args.get("env-file") || null);
  const env = {
    ...loadedEnv,
    RELEASE_ID: args.get("release-id") || loadedEnv.RELEASE_ID || "",
    RELEASE_MANIFEST: args.get("manifest") || loadedEnv.RELEASE_MANIFEST || "",
    COMMERCIAL_EVIDENCE_DIR: args.get("evidence-dir") || loadedEnv.COMMERCIAL_EVIDENCE_DIR || "",
  };
  const evidenceRoot = path.resolve(process.cwd(), args.get("evidence-root") || env.COMMERCIAL_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT);
  const policyUrlSource = args.get("policy-url-source") || env.POLICY_URL_SOURCE || "public/mobile.js";
  const outDir = args.get("output-dir")
    ? path.resolve(process.cwd(), args.get("output-dir"))
    : path.join(evidenceRoot, utcTimestamp());
  fs.mkdirSync(outDir, { recursive: true });

  const report = evaluateCommercialGo({ env, evidenceRoot, policyUrlSource });
  const jsonPath = path.join(outDir, "commercial-go-validation.json");
  const scorecardPath = path.resolve(
    process.cwd(),
    args.get("scorecard-path") || env.COMMERCIAL_SCORECARD_PATH || path.join(outDir, "commercial-go-scorecard.md")
  );
  const summaryPath = path.join(outDir, "COMMERCIAL_GO_SUMMARY.md");

  writeJson(jsonPath, report);
  fs.mkdirSync(path.dirname(scorecardPath), { recursive: true });
  fs.writeFileSync(scorecardPath, renderCommercialScorecard(report), "utf8");
  fs.writeFileSync(summaryPath, renderSummaryMarkdown(report, { json: jsonPath, scorecard: scorecardPath }), "utf8");

  console.log(
    JSON.stringify(
      {
        ok: true,
        generated_at: new Date().toISOString(),
        verdict: report.verdict,
        score: report.score,
        output_dir: outDir,
        json: jsonPath,
        scorecard: scorecardPath,
        summary: summaryPath,
      },
      null,
      2
    )
  );
}

const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
  main();
}
