import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNTABLE_SIGNER_ROLES,
  MANIFEST_CLOCK_SKEW_MS,
  RELEASE_MANIFEST_MAX_VALIDITY_MS,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  signedManifestPayload,
  validateReleaseManifestShape,
} from "../scripts/production-validation/release-identity.mjs";
import {
  APPROVAL_MANIFEST_MAX_VALIDITY_MS,
  APPROVAL_REQUIRED_SIGNER_ROLE,
  EVIDENCE_MANIFEST_MAX_VALIDITY_MS,
} from "../scripts/production-validation/signed-release-evidence.mjs";

const ROOT = process.cwd();
const ED25519_CANONICAL_BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/][AQgw]==$";

function readSchema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

test("release, evidence, and approval schemas are versioned and parseable", () => {
  const contracts = [
    ["docs/contracts/release-manifest-v1.schema.json", "release_manifest_v1"],
    ["docs/contracts/commercial-evidence-manifest-v1.schema.json", "commercial_evidence_manifest_v1"],
    ["docs/contracts/commercial-approval-manifest-v1.schema.json", "commercial_approval_manifest_v1"],
  ];
  for (const [relativePath, version] of contracts) {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
    assert.equal(schema.properties.schema_version.const, version);
    assert.equal(schema.additionalProperties, false);
  }
  assert.equal(RELEASE_MANIFEST_SCHEMA_VERSION, "release_manifest_v1");
});

test("schema annotations stay aligned with runtime TTL, role, and key-separation rules", () => {
  const releaseSchema = readSchema("docs/contracts/release-manifest-v1.schema.json");
  const evidenceSchema = readSchema("docs/contracts/commercial-evidence-manifest-v1.schema.json");
  const approvalSchema = readSchema("docs/contracts/commercial-approval-manifest-v1.schema.json");

  assert.equal(releaseSchema["x-clock-skew-seconds"] * 1000, MANIFEST_CLOCK_SKEW_MS);
  assert.equal(evidenceSchema["x-clock-skew-seconds"] * 1000, MANIFEST_CLOCK_SKEW_MS);
  assert.equal(approvalSchema["x-clock-skew-seconds"] * 1000, MANIFEST_CLOCK_SKEW_MS);
  assert.equal(releaseSchema["x-max-validity-seconds"] * 1000, RELEASE_MANIFEST_MAX_VALIDITY_MS);
  assert.equal(evidenceSchema["x-max-validity-seconds"] * 1000, EVIDENCE_MANIFEST_MAX_VALIDITY_MS);
  assert.equal(approvalSchema["x-max-validity-seconds"] * 1000, APPROVAL_MANIFEST_MAX_VALIDITY_MS);
  assert.equal(approvalSchema.$defs.approval["x-max-validity-seconds"] * 1000, APPROVAL_MANIFEST_MAX_VALIDITY_MS);

  assert.deepEqual(approvalSchema["x-required-role-by-approval-id"], APPROVAL_REQUIRED_SIGNER_ROLE);
  assert.deepEqual(
    new Set(approvalSchema.$defs.approval.properties.approver_role.enum),
    new Set(ACCOUNTABLE_SIGNER_ROLES),
  );
  assert.equal(approvalSchema.$defs.approval.additionalProperties, false);
  assert.ok(approvalSchema.$defs.approval.required.includes("approver_key_id"));
  assert.equal(approvalSchema["x-accountable-signers-require-distinct-keys"], true);
  assert.equal(
    releaseSchema["x-key-separation-policy"].accountable_roles_must_use_distinct_keys,
    true,
  );
  assert.equal(
    releaseSchema["x-key-separation-policy"].release_evidence_approval_domains_must_use_distinct_keys,
    true,
  );

  for (const schema of [releaseSchema, evidenceSchema, approvalSchema]) {
    assert.equal(schema.$defs.signature.properties.encoding.const, "base64");
    assert.equal(schema.$defs.signature.properties.signature_base64.pattern, ED25519_CANONICAL_BASE64_PATTERN);
  }
});

test("draft release template is deliberately fail-closed", () => {
  const draft = JSON.parse(fs.readFileSync(
    path.join(ROOT, "docs/production-evidence-templates/RELEASE_MANIFEST.DRAFT.json"),
    "utf8"
  ));
  const result = validateReleaseManifestShape(draft);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("manifest_release_id_invalid"));
  assert.ok(result.blockers.includes("manifest_trust_policy_release_signer_key_ids_invalid"));
  assert.equal(draft.revocation_status, "draft");
  assert.deepEqual(draft.signatures, []);
});

test("manifest signing payload excludes signatures but preserves release trust policy", () => {
  const manifest = {
    schema_version: "release_manifest_v1",
    release_id: "01981234-1234-7123-8123-123456789abc",
    trust_policy: { release_signer_key_ids: ["a".repeat(64)] },
    signatures: [{ signature_base64: "must-not-be-signed" }],
  };
  const payload = signedManifestPayload(manifest).toString("utf8");
  assert.doesNotMatch(payload, /must-not-be-signed/);
  assert.match(payload, /release_signer_key_ids/);
});
