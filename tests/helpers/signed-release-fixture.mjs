import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNTABLE_SIGNER_ROLES,
  RELEASE_MANIFEST_MAX_VALIDITY_MS,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  signedManifestPayload,
} from "../../scripts/production-validation/release-identity.mjs";
import {
  APPROVAL_MANIFEST_MAX_VALIDITY_MS,
  APPROVAL_MANIFEST_SCHEMA_VERSION,
  APPROVAL_REQUIRED_SIGNER_ROLE,
  EVIDENCE_MANIFEST_MAX_VALIDITY_MS,
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  REQUIRED_EVIDENCE_ARTIFACTS,
} from "../../scripts/production-validation/signed-release-evidence.mjs";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function signManifest(manifest, signers) {
  const payload = signedManifestPayload(manifest);
  return {
    ...manifest,
    signatures: signers.map((signer) => ({
      algorithm: "ed25519",
      encoding: "base64",
      key_id: signer.keyId,
      signer_role: signer.signerRole,
      public_key_pem: signer.publicKey,
      signature_base64: crypto.sign(null, payload, signer.privateKey).toString("base64"),
    })),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

export function createRepositorySignedReleaseFixture(repositoryRoot = process.cwd()) {
  const fixtureRoot = fs.mkdtempSync(path.join(repositoryRoot, ".tmp-signed-functional-gate-"));
  const evidenceDir = path.join(fixtureRoot, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const relativeToRepository = (filePath) => path.relative(repositoryRoot, filePath).split(path.sep).join("/");
  const createSigner = (signerRole) => {
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
    const keyId = sha256(publicKey);
    const keyPath = path.join(fixtureRoot, `trusted-${signerRole}.pem`);
    fs.writeFileSync(keyPath, publicKey, "utf8");
    return {
      signerRole,
      privateKey: keyPair.privateKey,
      publicKey,
      keyId,
      relativePath: relativeToRepository(keyPath),
    };
  };

  const now = Date.now();
  const issuedAt = new Date(now - 60_000).toISOString();
  const releaseExpiresAt = new Date(now - 60_000 + RELEASE_MANIFEST_MAX_VALIDITY_MS).toISOString();
  const evidenceExpiresAt = new Date(now - 60_000 + EVIDENCE_MANIFEST_MAX_VALIDITY_MS).toISOString();
  const approvalExpiresAt = new Date(now - 60_000 + APPROVAL_MANIFEST_MAX_VALIDITY_MS).toISOString();
  const releaseSigner = createSigner("release_authority");
  const evidenceSigner = createSigner("evidence_verifier");
  const approvalSigners = Object.fromEntries(
    ACCOUNTABLE_SIGNER_ROLES.map((role) => [role, createSigner(role)]),
  );

  const releaseArtifactContracts = {
    source_hash: ["source.tar", "source_archive", "application/x-tar"],
    lockfile_hash: ["package-lock.json", "npm_lockfile", "application/json"],
    migration_hash: ["migrations.json", "migration_bundle", "application/json"],
    env_hash: ["production-env.json", "nonsecret_environment", "application/json"],
    db_snapshot_hash: ["db-snapshot.sqlite3", "database_snapshot", "application/vnd.sqlite3"],
    backup_hash: ["backup.tar", "backup_archive", "application/x-tar"],
  };
  const releaseArtifactHashes = {};
  const releaseArtifactEntries = [];
  for (const [field, [fileName, artifactType, mediaType]] of Object.entries(releaseArtifactContracts)) {
    const content = `${field}-signed-functional-gate-fixture`;
    const filePath = path.join(fixtureRoot, "release", fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    releaseArtifactHashes[field] = sha256(content);
    releaseArtifactEntries.push({
      field,
      path: relativeToRepository(filePath),
      sha256: releaseArtifactHashes[field],
      artifact_type: artifactType,
      media_type: mediaType,
    });
  }

  const release = {
    release_id: "01981234-1234-7123-8123-123456789abc",
    commit: "a".repeat(40),
    source_hash: releaseArtifactHashes.source_hash,
    app_image_digest: `sha256:${"c".repeat(64)}`,
    environment_id: "prod-jp-east-1",
  };
  const evidenceArtifacts = [];
  for (const [evidenceId, fileName] of Object.entries(REQUIRED_EVIDENCE_ARTIFACTS)) {
    const content = `# ${evidenceId}\n\n- status: pass\n`;
    fs.writeFileSync(path.join(evidenceDir, fileName), content, "utf8");
    evidenceArtifacts.push({
      evidence_id: evidenceId,
      path: fileName,
      sha256: sha256(content),
      media_type: "text/markdown",
    });
  }

  const env = {
    RELEASE_ID: release.release_id,
    RELEASE_MODE: "commercial",
    RELEASE_ENVIRONMENT_ID: release.environment_id,
    COMMERCIAL_EVIDENCE_ROOT: fixtureRoot,
    COMMERCIAL_EVIDENCE_DIR: evidenceDir,
    RELEASE_TRUSTED_PUBLIC_KEY_PATHS: releaseSigner.relativePath,
    RELEASE_REVOKED_KEY_IDS: "",
    RELEASE_SIGNER_REGISTRY_JSON: JSON.stringify([{
      signer_role: "release_authority",
      key_id: releaseSigner.keyId,
    }]),
    APP_IMAGE_REF: `registry.invalid/jpyc@${release.app_image_digest}`,
    NGINX_IMAGE_REF: `registry.invalid/nginx@sha256:${"d".repeat(64)}`,
    EVIDENCE_TRUSTED_PUBLIC_KEY_PATHS: evidenceSigner.relativePath,
    EVIDENCE_REVOKED_KEY_IDS: "",
    EVIDENCE_SIGNER_REGISTRY_JSON: JSON.stringify([{
      signer_role: "evidence_verifier",
      key_id: evidenceSigner.keyId,
    }]),
    APPROVAL_TRUSTED_PUBLIC_KEY_PATHS: ACCOUNTABLE_SIGNER_ROLES
      .map((role) => approvalSigners[role].relativePath)
      .join(","),
    APPROVAL_REVOKED_KEY_IDS: "",
    APPROVAL_SIGNER_REGISTRY_JSON: JSON.stringify(ACCOUNTABLE_SIGNER_ROLES.map((signerRole) => ({
      signer_role: signerRole,
      key_id: approvalSigners[signerRole].keyId,
    }))),
    LEGAL_GATE_APPROVED: "true",
    LEGAL_GATE_APPROVAL_REF: "LEGAL-2026-001",
    AML_POLICY_APPROVED: "true",
    AML_POLICY_APPROVAL_REF: "AML-2026-001",
    PRIVACY_POLICY_APPROVED: "true",
    PRIVACY_POLICY_APPROVAL_REF: "PRIVACY-2026-001",
    APPI_POLICY_APPROVED: "true",
    APPI_POLICY_APPROVAL_REF: "APPI-2026-001",
    APPI_RETENTION_POLICY_REF: "APPI-RET-2026-001",
    APPI_DELETION_PROCEDURE_REF: "APPI-DEL-2026-001",
    APPI_DISCLOSURE_PROCEDURE_REF: "APPI-DISC-2026-001",
    JPYC_CONTRACT_APPROVAL_REF: "JPYC-2026-001",
    CONFIRMATIONS_POLICY_APPROVAL_REF: "CONF-2026-001",
    BACKSCAN_POLICY_APPROVAL_REF: "BACKSCAN-2026-001",
    REFUND_TREASURY_APPROVAL_REF: "TREASURY-2026-001",
  };
  const shimDir = path.join(fixtureRoot, "bin");
  const gitShimPath = path.join(shimDir, "git");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(
    gitShimPath,
    `#!/bin/sh\nif [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then\n  printf '%s\\n' '${release.commit}'\n  exit 0\nfi\nif [ "$1" = "status" ] && [ "$2" = "--porcelain" ]; then\n  exit 0\nfi\nexec /usr/bin/git "$@"\n`,
    "utf8",
  );
  fs.chmodSync(gitShimPath, 0o755);
  env.PATH = `${shimDir}${path.delimiter}${process.env.PATH || ""}`;
  const approvalRefs = {
    legal: env.LEGAL_GATE_APPROVAL_REF,
    aml: env.AML_POLICY_APPROVAL_REF,
    privacy: env.PRIVACY_POLICY_APPROVAL_REF,
    appi: env.APPI_POLICY_APPROVAL_REF,
    jpyc_contract: env.JPYC_CONTRACT_APPROVAL_REF,
    confirmation_policy: env.CONFIRMATIONS_POLICY_APPROVAL_REF,
    backscan_policy: env.BACKSCAN_POLICY_APPROVAL_REF,
    refund_treasury: env.REFUND_TREASURY_APPROVAL_REF,
  };
  const approvals = [];
  for (const [approvalId, approvalRef] of Object.entries(approvalRefs)) {
    const documentPath = `approvals/${approvalId}.md`;
    const documentAbsolutePath = path.join(evidenceDir, documentPath);
    const content = `# ${approvalId}\n\nref: ${approvalRef}\n`;
    fs.mkdirSync(path.dirname(documentAbsolutePath), { recursive: true });
    fs.writeFileSync(documentAbsolutePath, content, "utf8");
    const signerRole = APPROVAL_REQUIRED_SIGNER_ROLE[approvalId];
    approvals.push({
      approval_id: approvalId,
      status: "approved",
      approval_ref: approvalRef,
      scope: "selected release fingerprint",
      approver_id: `${approvalId}-owner`,
      approver_role: signerRole,
      approver_key_id: approvalSigners[signerRole].keyId,
      approved_at: issuedAt,
      expires_at: approvalExpiresAt,
      revoked_at: null,
      document_path: documentPath,
      document_sha256: sha256(content),
      ...(approvalId === "appi" ? {
        procedure_refs: {
          APPI_RETENTION_POLICY_REF: env.APPI_RETENTION_POLICY_REF,
          APPI_DELETION_PROCEDURE_REF: env.APPI_DELETION_PROCEDURE_REF,
          APPI_DISCLOSURE_PROCEDURE_REF: env.APPI_DISCLOSURE_PROCEDURE_REF,
        },
      } : {}),
    });
  }

  const evidenceManifest = signManifest({
    schema_version: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    release,
    issued_at: issuedAt,
    expires_at: evidenceExpiresAt,
    revocation_status: "valid",
    artifacts: evidenceArtifacts,
  }, [evidenceSigner]);
  const approvalManifest = signManifest({
    schema_version: APPROVAL_MANIFEST_SCHEMA_VERSION,
    release,
    issued_at: issuedAt,
    expires_at: approvalExpiresAt,
    revocation_status: "valid",
    approvals,
  }, ACCOUNTABLE_SIGNER_ROLES.map((role) => approvalSigners[role]));
  const evidenceManifestPath = path.join(evidenceDir, "EVIDENCE_MANIFEST.json");
  const approvalManifestPath = path.join(evidenceDir, "APPROVAL_MANIFEST.json");
  writeJson(evidenceManifestPath, evidenceManifest);
  writeJson(approvalManifestPath, approvalManifest);

  const unsignedReleaseManifest = {
    schema_version: RELEASE_MANIFEST_SCHEMA_VERSION,
    ...release,
    mode: "commercial",
    lockfile_hash: releaseArtifactHashes.lockfile_hash,
    migration_hash: releaseArtifactHashes.migration_hash,
    runtime: { node: "24.17.0" },
    base_image_digest: `sha256:${"e".repeat(64)}`,
    nginx_image_digest: `sha256:${"d".repeat(64)}`,
    env_hash: releaseArtifactHashes.env_hash,
    db_snapshot_hash: releaseArtifactHashes.db_snapshot_hash,
    backup_hash: releaseArtifactHashes.backup_hash,
    audit_root: `sha256:${"f".repeat(64)}`,
    trust_policy: {
      release_signer_key_ids: [releaseSigner.keyId],
      evidence_signer_key_ids: [evidenceSigner.keyId],
      approval_signers: Object.fromEntries(ACCOUNTABLE_SIGNER_ROLES.map(
        (signerRole) => [signerRole, [approvalSigners[signerRole].keyId]],
      )),
      revoked_key_ids: [],
    },
    evidence_manifest_hash: sha256(fs.readFileSync(evidenceManifestPath)),
    approval_manifest_hash: sha256(fs.readFileSync(approvalManifestPath)),
    artifact_hashes: [
      ...releaseArtifactEntries,
      {
        field: "evidence_manifest_hash",
        path: relativeToRepository(evidenceManifestPath),
        sha256: sha256(fs.readFileSync(evidenceManifestPath)),
        artifact_type: "evidence_manifest",
        media_type: "application/json",
      },
      {
        field: "approval_manifest_hash",
        path: relativeToRepository(approvalManifestPath),
        sha256: sha256(fs.readFileSync(approvalManifestPath)),
        artifact_type: "approval_manifest",
        media_type: "application/json",
      },
    ],
    issued_at: issuedAt,
    expires_at: releaseExpiresAt,
    revocation_status: "valid",
  };
  const releaseManifestPath = path.join(fixtureRoot, "release", "RELEASE_MANIFEST.json");
  writeJson(releaseManifestPath, signManifest(unsignedReleaseManifest, [releaseSigner]));
  env.RELEASE_MANIFEST = relativeToRepository(releaseManifestPath);

  return {
    root: fixtureRoot,
    evidenceDir,
    releaseManifestPath,
    env,
    cleanup() {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
}
