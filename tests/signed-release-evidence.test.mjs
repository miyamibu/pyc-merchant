import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ACCOUNTABLE_SIGNER_ROLES,
  MANIFEST_CLOCK_SKEW_MS,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_MANIFEST_MAX_VALIDITY_MS,
  signedManifestPayload,
  validateReleaseManifestShape,
  verifySignedManifestEnvelope,
} from "../scripts/production-validation/release-identity.mjs";
import { loadReleaseManifest } from "../scripts/production-validation/validate-commercial-go.mjs";
import {
  APPROVAL_MANIFEST_SCHEMA_VERSION,
  APPROVAL_MANIFEST_MAX_VALIDITY_MS,
  APPROVAL_REQUIRED_SIGNER_ROLE,
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_MANIFEST_MAX_VALIDITY_MS,
  REQUIRED_EVIDENCE_ARTIFACTS,
  evaluateReleaseBoundApproval,
  validateSignedReleaseEvidence,
} from "../scripts/production-validation/signed-release-evidence.mjs";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createSigner(root, signerRole) {
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const keyId = sha256(publicKey);
  const relativePath = `trusted-${signerRole}.pem`;
  fs.writeFileSync(path.join(root, relativePath), publicKey, "utf8");
  return { signerRole, keyPair, publicKey, keyId, relativePath };
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
      signature_base64: crypto.sign(null, payload, signer.keyPair.privateKey).toString("base64"),
    })),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "jpyc-signed-release-evidence-"));
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const now = Date.now();
  const issuedAt = new Date(now - 60_000).toISOString();
  const releaseExpiresAt = new Date(now - 60_000 + RELEASE_MANIFEST_MAX_VALIDITY_MS).toISOString();
  const evidenceExpiresAt = new Date(now - 60_000 + EVIDENCE_MANIFEST_MAX_VALIDITY_MS).toISOString();
  const approvalExpiresAt = new Date(now - 60_000 + APPROVAL_MANIFEST_MAX_VALIDITY_MS).toISOString();
  const releaseSigner = createSigner(root, "release_authority");
  const evidenceSigner = createSigner(root, "evidence_verifier");
  const approvalSigners = Object.fromEntries(
    ACCOUNTABLE_SIGNER_ROLES.map((role) => [role, createSigner(root, role)]),
  );

  const releaseArtifactContracts = {
    source_hash: ["release/source.tar", "source_archive", "application/x-tar"],
    lockfile_hash: ["release/package-lock.json", "npm_lockfile", "application/json"],
    migration_hash: ["release/migrations.json", "migration_bundle", "application/json"],
    env_hash: ["release/production-env.json", "nonsecret_environment", "application/json"],
    db_snapshot_hash: ["release/db-snapshot.sqlite3", "database_snapshot", "application/vnd.sqlite3"],
    backup_hash: ["release/backup.tar", "backup_archive", "application/x-tar"],
  };
  const releaseArtifactHashes = {};
  const releaseArtifactEntries = [];
  for (const [field, [relativePath, artifactType, mediaType]] of Object.entries(releaseArtifactContracts)) {
    const content = `${field}-signed-fixture`;
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content, "utf8");
    releaseArtifactHashes[field] = sha256(content);
    releaseArtifactEntries.push({
      field,
      path: relativePath,
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
    RELEASE_ENVIRONMENT_ID: release.environment_id,
    RELEASE_TRUSTED_PUBLIC_KEY_PATHS: releaseSigner.relativePath,
    RELEASE_REVOKED_KEY_IDS: "",
    RELEASE_SIGNER_REGISTRY_JSON: JSON.stringify([{ signer_role: "release_authority", key_id: releaseSigner.keyId }]),
    APP_IMAGE_REF: `registry.example/jpyc@${release.app_image_digest}`,
    NGINX_IMAGE_REF: `registry.example/nginx@sha256:${"d".repeat(64)}`,
    EVIDENCE_TRUSTED_PUBLIC_KEY_PATHS: evidenceSigner.relativePath,
    EVIDENCE_REVOKED_KEY_IDS: "",
    EVIDENCE_SIGNER_REGISTRY_JSON: JSON.stringify([{ signer_role: "evidence_verifier", key_id: evidenceSigner.keyId }]),
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
  const refs = {
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
  for (const [approvalId, approvalRef] of Object.entries(refs)) {
    const documentPath = `approvals/${approvalId}.md`;
    const content = `# ${approvalId}\n\nref: ${approvalRef}\n`;
    fs.mkdirSync(path.dirname(path.join(evidenceDir, documentPath)), { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, documentPath), content, "utf8");
    approvals.push({
      approval_id: approvalId,
      status: "approved",
      approval_ref: approvalRef,
      scope: "selected release fingerprint",
      approver_id: `${approvalId}-owner`,
      approver_role: APPROVAL_REQUIRED_SIGNER_ROLE[approvalId],
      approver_key_id: approvalSigners[APPROVAL_REQUIRED_SIGNER_ROLE[approvalId]].keyId,
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
        path: "evidence/EVIDENCE_MANIFEST.json",
        sha256: sha256(fs.readFileSync(evidenceManifestPath)),
        artifact_type: "evidence_manifest",
        media_type: "application/json",
      },
      {
        field: "approval_manifest_hash",
        path: "evidence/APPROVAL_MANIFEST.json",
        sha256: sha256(fs.readFileSync(approvalManifestPath)),
        artifact_type: "approval_manifest",
        media_type: "application/json",
      },
    ],
    issued_at: issuedAt,
    expires_at: releaseExpiresAt,
    revocation_status: "valid",
  };
  const releaseManifest = signManifest(unsignedReleaseManifest, [releaseSigner]);
  const releaseManifestPath = path.join(root, "release", "RELEASE_MANIFEST.json");
  writeJson(releaseManifestPath, releaseManifest);
  return {
    root,
    evidenceDir,
    env,
    now,
    issuedAt,
    releaseExpiresAt,
    evidenceExpiresAt,
    approvalExpiresAt,
    releaseSigner,
    evidenceSigner,
    approvalSigners,
    evidenceManifest,
    approvalManifest,
    releaseManifest,
    releaseManifestPath,
    evidenceManifestPath,
    approvalManifestPath,
  };
}

function resignReleaseManifest(fixture, mutate = () => {}) {
  const unsigned = structuredClone(fixture.releaseManifest);
  mutate(unsigned);
  fixture.releaseManifest = signManifest(unsigned, [fixture.releaseSigner]);
  writeJson(fixture.releaseManifestPath, fixture.releaseManifest);
  return fixture.releaseManifest;
}

function replaceBoundManifest(fixture, kind, mutate, signers) {
  const isApproval = kind === "approval";
  const field = isApproval ? "approval_manifest_hash" : "evidence_manifest_hash";
  const filePath = isApproval ? fixture.approvalManifestPath : fixture.evidenceManifestPath;
  const current = structuredClone(isApproval ? fixture.approvalManifest : fixture.evidenceManifest);
  mutate(current);
  const signed = signManifest(current, signers);
  if (isApproval) fixture.approvalManifest = signed;
  else fixture.evidenceManifest = signed;
  writeJson(filePath, signed);
  const digest = sha256(fs.readFileSync(filePath));
  resignReleaseManifest(fixture, (releaseManifest) => {
    releaseManifest[field] = digest;
    releaseManifest.artifact_hashes = releaseManifest.artifact_hashes.map((entry) => (
      entry.field === field ? { ...entry, sha256: digest } : entry
    ));
  });
  return signed;
}

function validateFixture(fixture, options = {}) {
  return validateSignedReleaseEvidence({
    releaseManifestResult: { ok: true, manifest: fixture.releaseManifest },
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
    now: fixture.now,
    ...options,
  });
}

function verifyFixtureReleaseEnvelope(fixture, manifest = fixture.releaseManifest, now = fixture.now) {
  return verifySignedManifestEnvelope(manifest, fixture.env, {
    root: fixture.root,
    blockerPrefix: "manifest",
    now,
    signerRegistryEnv: "RELEASE_SIGNER_REGISTRY_JSON",
    requiredSignerRoles: ["release_authority"],
    allowedSignerKeyIds: manifest.trust_policy.release_signer_key_ids,
    additionalRevokedKeyIds: manifest.trust_policy.revoked_key_ids,
    maxValidityMs: RELEASE_MANIFEST_MAX_VALIDITY_MS,
  });
}

function withReleaseTimes(fixture, issuedAtMs, expiresAtMs) {
  const manifest = structuredClone(fixture.releaseManifest);
  manifest.issued_at = new Date(issuedAtMs).toISOString();
  manifest.expires_at = new Date(expiresAtMs).toISOString();
  return signManifest(manifest, [fixture.releaseSigner]);
}

function nonCanonicalPadBits(encoded) {
  assert.match(encoded, /==$/);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const index = encoded.length - 3;
  const canonicalValue = alphabet.indexOf(encoded[index]);
  assert.equal(canonicalValue % 16, 0);
  return `${encoded.slice(0, index)}${alphabet[canonicalValue + 1]}${encoded.slice(index + 1)}`;
}

test("signed release, evidence, and approval manifests validate end to end", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const releaseResult = loadReleaseManifest("release/RELEASE_MANIFEST.json", fixture.env, {
    root: fixture.root,
  });
  assert.equal(releaseResult.ok, true, JSON.stringify(releaseResult.blockers));
  const evidenceResult = validateSignedReleaseEvidence({
    releaseManifestResult: releaseResult,
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
  });
  assert.equal(evidenceResult.ok, true, JSON.stringify(evidenceResult.blockers));
  assert.equal(releaseResult.signature_verification.valid_signer_roles.includes("release_authority"), true);
  const domainKeys = [
    fixture.releaseSigner.keyId,
    fixture.evidenceSigner.keyId,
    ...ACCOUNTABLE_SIGNER_ROLES.map((role) => fixture.approvalSigners[role].keyId),
  ];
  assert.equal(new Set(domainKeys).size, 8);
  for (const approval of fixture.approvalManifest.approvals) {
    const expectedRole = APPROVAL_REQUIRED_SIGNER_ROLE[approval.approval_id];
    assert.equal(approval.approver_role, expectedRole);
    assert.equal(approval.approver_key_id, fixture.approvalSigners[expectedRole].keyId);
  }
});

test("signed evidence and approvals pass only when bound to the selected release", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = validateSignedReleaseEvidence({
    releaseManifestResult: { ok: true, manifest: fixture.releaseManifest },
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
  });
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  assert.ok(Object.values(result.approval_gates).every((gate) => gate.ok));
  assert.equal(Object.keys(result.evidence_artifacts.verified).length, 8);
});

test("functional approvals require a verified document in a signed manifest bound to the selected release", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const releaseResult = loadReleaseManifest("release/RELEASE_MANIFEST.json", fixture.env, {
    root: fixture.root,
  });
  const signedEvidence = validateSignedReleaseEvidence({
    releaseManifestResult: releaseResult,
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
  });
  for (const approvalId of ["legal", "aml", "privacy", "appi"]) {
    const approval = evaluateReleaseBoundApproval({
      releaseManifestResult: releaseResult,
      signedEvidence,
      approvalId,
    });
    assert.equal(approval.ok, true, `${approvalId}: ${JSON.stringify(approval.blockers)}`);
  }

  const legacyOnly = evaluateReleaseBoundApproval({
    releaseManifestResult: { ok: false, manifest: null },
    signedEvidence: {
      approval_gates: {
        legal: { ok: true, errors: [] },
      },
      approval_documents: {
        verified: { legal: { sha256: "a".repeat(64) } },
      },
      blockers: [],
    },
    approvalId: "legal",
  });
  assert.equal(legacyOnly.ok, false);
  assert.ok(legacyOnly.blockers.includes("release_manifest_invalid"));
  assert.ok(legacyOnly.blockers.includes("approval_manifest_invalid"));

  const wrongRelease = structuredClone(signedEvidence);
  wrongRelease.blockers = [...wrongRelease.blockers, "approval_manifest_commit_mismatch"];
  const mismatched = evaluateReleaseBoundApproval({
    releaseManifestResult: releaseResult,
    signedEvidence: wrongRelease,
    approvalId: "aml",
  });
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.blockers.includes("approval_manifest_commit_mismatch"));
});

test("a valid signature from another release is rejected", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.releaseManifest.commit = "f".repeat(40);
  const result = validateSignedReleaseEvidence({
    releaseManifestResult: { ok: true, manifest: fixture.releaseManifest },
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("evidence_manifest_commit_mismatch"));
  assert.ok(result.blockers.includes("approval_manifest_commit_mismatch"));
});

test("the deployment environment id is bound to release, evidence, and approvals", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.env.RELEASE_ENVIRONMENT_ID = "prod-jp-west-1";
  const releaseResult = loadReleaseManifest("release/RELEASE_MANIFEST.json", fixture.env, {
    root: fixture.root,
  });
  assert.equal(releaseResult.ok, false);
  assert.ok(releaseResult.blockers.includes("manifest_release_environment_id_mismatch"));
  const evidenceResult = validateFixture(fixture);
  assert.equal(evidenceResult.ok, false);
  assert.ok(evidenceResult.blockers.includes("release_environment_id_mismatch"));
});

test("approval records bind approval id to the required role and that role's valid key", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  replaceBoundManifest(fixture, "approval", (manifest) => {
    const legal = manifest.approvals.find((approval) => approval.approval_id === "legal");
    legal.approver_role = "aml_accountable";
    legal.approver_key_id = fixture.approvalSigners.aml_accountable.keyId;
  }, ACCOUNTABLE_SIGNER_ROLES.map((role) => fixture.approvalSigners[role]));
  const roleTamper = validateFixture(fixture);
  assert.equal(roleTamper.ok, false);
  assert.ok(roleTamper.blockers.includes("legal_approver_role_mismatch"));

  replaceBoundManifest(fixture, "approval", (manifest) => {
    const legal = manifest.approvals.find((approval) => approval.approval_id === "legal");
    legal.approver_role = "legal_accountable";
    legal.approver_key_id = fixture.approvalSigners.aml_accountable.keyId;
  }, ACCOUNTABLE_SIGNER_ROLES.map((role) => fixture.approvalSigners[role]));
  const keyTamper = validateFixture(fixture);
  assert.equal(keyTamper.ok, false);
  assert.ok(keyTamper.blockers.includes("legal_approver_key_not_manifest_signer"));
  assert.ok(keyTamper.blockers.includes("legal_approver_key_not_release_trusted"));
});

test("release trust policy rejects shared accountable keys and cross-domain keys", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sharedAccountable = structuredClone(fixture.releaseManifest);
  sharedAccountable.trust_policy.approval_signers.aml_accountable = [
    fixture.approvalSigners.legal_accountable.keyId,
  ];
  const sharedResult = validateReleaseManifestShape(sharedAccountable);
  assert.equal(sharedResult.ok, false);
  assert.ok(sharedResult.blockers.includes("manifest_trust_policy_accountable_roles_share_key"));

  const crossDomain = structuredClone(fixture.releaseManifest);
  crossDomain.trust_policy.evidence_signer_key_ids = [fixture.releaseSigner.keyId];
  crossDomain.trust_policy.approval_signers.legal_accountable = [fixture.releaseSigner.keyId];
  const crossDomainResult = validateReleaseManifestShape(crossDomain);
  assert.equal(crossDomainResult.ok, false);
  assert.ok(crossDomainResult.blockers.includes("manifest_trust_policy_release_evidence_keys_overlap"));
  assert.ok(crossDomainResult.blockers.includes("manifest_trust_policy_approval_keys_overlap_other_domains"));
});

test("copying one valid approval signature into another accountable role is rejected", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const copied = structuredClone(fixture.approvalManifest);
  const legalSignature = copied.signatures.find((signature) => signature.signer_role === "legal_accountable");
  const amlIndex = copied.signatures.findIndex((signature) => signature.signer_role === "aml_accountable");
  copied.signatures[amlIndex] = { ...legalSignature, signer_role: "aml_accountable" };
  const sharedRegistry = JSON.stringify([
    ...ACCOUNTABLE_SIGNER_ROLES
      .filter((role) => !["legal_accountable", "aml_accountable"].includes(role))
      .map((role) => ({ signer_role: role, key_id: fixture.approvalSigners[role].keyId })),
    { signer_role: "legal_accountable", key_id: fixture.approvalSigners.legal_accountable.keyId },
    { signer_role: "aml_accountable", key_id: fixture.approvalSigners.legal_accountable.keyId },
  ]);
  const allowedRoleKeyIds = structuredClone(fixture.releaseManifest.trust_policy.approval_signers);
  allowedRoleKeyIds.aml_accountable = [fixture.approvalSigners.legal_accountable.keyId];
  const result = verifySignedManifestEnvelope(copied, {
    ...fixture.env,
    APPROVAL_SIGNER_REGISTRY_JSON: sharedRegistry,
  }, {
    root: fixture.root,
    blockerPrefix: "approval_manifest",
    now: fixture.now,
    trustedKeyPathsEnv: "APPROVAL_TRUSTED_PUBLIC_KEY_PATHS",
    signerRegistryEnv: "APPROVAL_SIGNER_REGISTRY_JSON",
    requiredSignerRoles: ACCOUNTABLE_SIGNER_ROLES,
    allowedSignerRoleKeyIds: allowedRoleKeyIds,
    requireDistinctSignerKeysPerRole: true,
    maxValidityMs: APPROVAL_MANIFEST_MAX_VALIDITY_MS,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("approval_manifest_signer_registry_key_assigned_multiple_roles"));
  assert.ok(result.blockers.includes("approval_manifest_valid_signature_key_used_for_multiple_roles"));
  assert.ok(result.blockers.includes("approval_manifest_required_roles_not_key_separated"));
});

test("signed manifests reject whitespace, newlines, excess padding, and noncanonical pad bits", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const canonical = fixture.releaseManifest.signatures[0].signature_base64;
  const mutations = [
    ` ${canonical}`,
    `${canonical} `,
    `${canonical.slice(0, 12)}\n${canonical.slice(12)}`,
    `${canonical}=`,
    nonCanonicalPadBits(canonical),
  ];
  for (const mutation of mutations) {
    const manifest = structuredClone(fixture.releaseManifest);
    manifest.signatures[0].signature_base64 = mutation;
    const result = verifyFixtureReleaseEnvelope(fixture, manifest);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(result.blockers.includes("manifest_signature_0_base64_not_canonical"), JSON.stringify(result.blockers));
  }
});

test("release validity ordering, maximum TTL, and clock-skew boundaries are fail-closed", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const issuedAt = fixture.now - 1_000;
  const exactMax = withReleaseTimes(fixture, issuedAt, issuedAt + RELEASE_MANIFEST_MAX_VALIDITY_MS);
  assert.equal(verifyFixtureReleaseEnvelope(fixture, exactMax).ok, true);

  const overMax = withReleaseTimes(fixture, issuedAt, issuedAt + RELEASE_MANIFEST_MAX_VALIDITY_MS + 1);
  assert.ok(verifyFixtureReleaseEnvelope(fixture, overMax).blockers.includes("manifest_validity_window_exceeds_maximum"));

  const sameInstant = withReleaseTimes(fixture, fixture.now + 1_000, fixture.now + 1_000);
  assert.ok(verifyFixtureReleaseEnvelope(fixture, sameInstant).blockers.includes("manifest_validity_order_invalid"));

  const skewBoundary = withReleaseTimes(
    fixture,
    fixture.now + MANIFEST_CLOCK_SKEW_MS,
    fixture.now + MANIFEST_CLOCK_SKEW_MS + 1_000,
  );
  assert.equal(verifyFixtureReleaseEnvelope(fixture, skewBoundary).ok, true);
  const beyondSkew = withReleaseTimes(
    fixture,
    fixture.now + MANIFEST_CLOCK_SKEW_MS + 1,
    fixture.now + MANIFEST_CLOCK_SKEW_MS + 1_001,
  );
  assert.ok(verifyFixtureReleaseEnvelope(fixture, beyondSkew).blockers.includes("manifest_issued_at_in_future"));
});

test("evidence, approval manifest, and approval-record TTLs are bounded", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const issuedAtMs = fixture.now - 1_000;
  replaceBoundManifest(fixture, "evidence", (manifest) => {
    manifest.issued_at = new Date(issuedAtMs).toISOString();
    manifest.expires_at = new Date(issuedAtMs + EVIDENCE_MANIFEST_MAX_VALIDITY_MS + 1).toISOString();
  }, [fixture.evidenceSigner]);
  const evidenceTtl = validateFixture(fixture);
  assert.ok(evidenceTtl.blockers.includes("evidence_manifest_validity_window_exceeds_maximum"));

  replaceBoundManifest(fixture, "evidence", (manifest) => {
    manifest.issued_at = new Date(issuedAtMs).toISOString();
    manifest.expires_at = new Date(issuedAtMs + EVIDENCE_MANIFEST_MAX_VALIDITY_MS).toISOString();
  }, [fixture.evidenceSigner]);
  replaceBoundManifest(fixture, "approval", (manifest) => {
    manifest.issued_at = new Date(issuedAtMs).toISOString();
    manifest.expires_at = new Date(issuedAtMs + APPROVAL_MANIFEST_MAX_VALIDITY_MS + 1).toISOString();
    const legal = manifest.approvals.find((approval) => approval.approval_id === "legal");
    legal.approved_at = new Date(issuedAtMs).toISOString();
    legal.expires_at = new Date(issuedAtMs + APPROVAL_MANIFEST_MAX_VALIDITY_MS + 1).toISOString();
  }, ACCOUNTABLE_SIGNER_ROLES.map((role) => fixture.approvalSigners[role]));
  const approvalTtl = validateFixture(fixture);
  assert.ok(approvalTtl.blockers.includes("approval_manifest_validity_window_exceeds_maximum"));
  assert.ok(approvalTtl.blockers.includes("legal_validity_window_exceeds_maximum"));

  replaceBoundManifest(fixture, "approval", (manifest) => {
    manifest.expires_at = new Date(issuedAtMs + APPROVAL_MANIFEST_MAX_VALIDITY_MS).toISOString();
    const legal = manifest.approvals.find((approval) => approval.approval_id === "legal");
    legal.approved_at = new Date(issuedAtMs).toISOString();
    legal.expires_at = new Date(issuedAtMs).toISOString();
  }, ACCOUNTABLE_SIGNER_ROLES.map((role) => fixture.approvalSigners[role]));
  const approvalOrdering = validateFixture(fixture);
  assert.ok(approvalOrdering.blockers.includes("legal_validity_order_invalid"));
});

test("an arbitrary approval reference cannot satisfy a signed approval gate", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.env.LEGAL_GATE_APPROVAL_REF = "LEGAL-ARBITRARY-999";
  const result = validateSignedReleaseEvidence({
    releaseManifestResult: { ok: true, manifest: fixture.releaseManifest },
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
  });
  assert.equal(result.ok, false);
  assert.equal(result.approval_gates.legal.ok, false);
  assert.ok(result.blockers.includes("legal_LEGAL_GATE_APPROVAL_REF_mismatch"));
});

test("tampering with a signed evidence artifact is rejected by its manifest hash", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.appendFileSync(path.join(fixture.evidenceDir, "EXT-001-real-jpyc-payment.md"), "\n- tampered: true\n", "utf8");
  const result = validateSignedReleaseEvidence({
    releaseManifestResult: { ok: true, manifest: fixture.releaseManifest },
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("evidence_artifact_EXT-001_hash_mismatch"));
});

test("expired signed evidence and approval manifests are rejected deterministically", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = validateSignedReleaseEvidence({
    releaseManifestResult: { ok: true, manifest: fixture.releaseManifest },
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
    now: Date.parse("2100-01-01T00:00:00Z"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("evidence_manifest_expired"));
  assert.ok(result.blockers.includes("approval_manifest_expired"));
});

test("a cryptographically valid signature from a key absent from the accountable registry is rejected", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.env.APPROVAL_SIGNER_REGISTRY_JSON = "[]";
  const result = validateSignedReleaseEvidence({
    releaseManifestResult: { ok: true, manifest: fixture.releaseManifest },
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes("signer_role_not_trusted")));
});

test("revoked evidence and approval signing keys are rejected", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const keyId = JSON.parse(fixture.env.EVIDENCE_SIGNER_REGISTRY_JSON)[0].key_id;
  fixture.env.EVIDENCE_REVOKED_KEY_IDS = keyId;
  fixture.env.APPROVAL_REVOKED_KEY_IDS = keyId;
  const result = validateSignedReleaseEvidence({
    releaseManifestResult: { ok: true, manifest: fixture.releaseManifest },
    evidenceDir: fixture.evidenceDir,
    env: fixture.env,
    root: fixture.root,
    releaseMode: "commercial",
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes("revoked_key")));
});

test("missing signed manifests fail closed", () => {
  const result = validateSignedReleaseEvidence({
    releaseManifestResult: { ok: false, manifest: null },
    releaseMode: "commercial",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ["signed_evidence_requires_valid_release_manifest"]);
});
