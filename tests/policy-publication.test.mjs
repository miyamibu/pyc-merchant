import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  evaluatePolicyPublicationSource,
  isPublishedPolicyUrl,
  isPublishedPolicyVersion,
  validatePolicyVersionSubmission,
} from "../src/policy-publication.mjs";

const ROOT = process.cwd();

const PUBLISHED_VERSIONS = Object.freeze({
  terms_version: "2026-07-15",
  privacy_version: "2026-07-15",
  refund_policy_version: "2026-07-15",
});

function policySource({
  terms = "https://policies.merchant.jp/legal/terms",
  privacy = "https://policies.merchant.jp/legal/privacy",
  refund = "https://policies.merchant.jp/legal/refund",
  termsVersion = PUBLISHED_VERSIONS.terms_version,
  privacyVersion = PUBLISHED_VERSIONS.privacy_version,
  refundVersion = PUBLISHED_VERSIONS.refund_policy_version,
} = {}) {
  return `
const POLICY_URLS = {
  terms: "${terms}",
  privacy: "${privacy}",
  refund: "${refund}",
};
const POLICY_VERSIONS = {
  terms_version: "${termsVersion}",
  privacy_version: "${privacyVersion}",
  refund_policy_version: "${refundVersion}",
};
`;
}

test("published policy source requires production URLs and non-placeholder versions", () => {
  const ready = evaluatePolicyPublicationSource(policySource(), { sourcePath: "fixture.js" });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.missing_keys, []);
  assert.deepEqual(ready.missing_version_keys, []);
  assert.deepEqual(ready.versions, PUBLISHED_VERSIONS);

  for (const version of ["", "draft-v1", "pending-legal", "placeholder", "example-2026"]) {
    assert.equal(isPublishedPolicyVersion(version), false, `${version || "empty"} must be rejected`);
  }

  const draft = evaluatePolicyPublicationSource(policySource({ termsVersion: "draft-v1" }));
  assert.equal(draft.ok, false);
  assert.deepEqual(draft.missing_version_keys, ["terms_version"]);
});

test("policy URLs reject credentials, placeholders, local names, and non-public IP ranges", () => {
  const rejected = [
    "https://user:secret@merchant.example.jp/terms",
    "https://example.com/terms",
    "https://legal.example.org/terms",
    "https://example.net./terms",
    "https://merchant.invalid/terms",
    "https://merchant.test/terms",
    "https://merchant.example/terms",
    "https://reverse.arpa/terms",
    "https://intranet/terms",
    "https://localhost/terms",
    "https://localhost./terms",
    "https://service.localhost/terms",
    "https://merchant.local./terms",
    "https://0.0.0.0/terms",
    "https://127.0.0.1/terms",
    "https://127.1/terms",
    "https://10.0.0.1/terms",
    "https://172.16.0.1/terms",
    "https://172.31.255.255/terms",
    "https://192.168.1.1/terms",
    "https://169.254.1.1/terms",
    "https://[::]/terms",
    "https://[::1]/terms",
    "https://[fc00::1]/terms",
    "https://[fdff::1]/terms",
    "https://[fe80::1]/terms",
    "https://[febf::1]/terms",
    "https://[::ffff:127.0.0.1]/terms",
    "https://[::ffff:192.168.1.1]/terms",
    "https://8.8.8.8/terms",
    "https://[2001:4860:4860::8888]/terms",
  ];
  for (const url of rejected) assert.equal(isPublishedPolicyUrl(url), false, `${url} must be rejected`);

  for (const url of ["https://policies.merchant.jp/terms"]) {
    assert.equal(isPublishedPolicyUrl(url), true, `${url} should pass static publication validation`);
  }
});

test("consent version submission must contain exactly the three published values", () => {
  assert.deepEqual(validatePolicyVersionSubmission(PUBLISHED_VERSIONS, { ...PUBLISHED_VERSIONS }), {
    ok: true,
    missing_keys: [],
    mismatch_keys: [],
    unexpected_keys: [],
  });

  const mismatch = validatePolicyVersionSubmission(PUBLISHED_VERSIONS, {
    ...PUBLISHED_VERSIONS,
    terms_version: "2026-07-14",
  });
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.mismatch_keys, ["terms_version"]);

  const missing = validatePolicyVersionSubmission(PUBLISHED_VERSIONS, {
    terms_version: PUBLISHED_VERSIONS.terms_version,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing_keys, ["privacy_version", "refund_policy_version"]);

  const extra = validatePolicyVersionSubmission(PUBLISHED_VERSIONS, {
    ...PUBLISHED_VERSIONS,
    accepted_without_reading: true,
  });
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.unexpected_keys, ["accepted_without_reading"]);
});

test("current mobile policy configuration remains fail-closed until publication", () => {
  const sourcePath = path.join(ROOT, "public/mobile.js");
  const current = evaluatePolicyPublicationSource(fs.readFileSync(sourcePath, "utf8"), { sourcePath });
  assert.equal(current.ok, false);
  assert.deepEqual(current.missing_keys, ["terms", "privacy", "refund"]);
  assert.deepEqual(current.missing_version_keys, ["terms_version", "privacy_version", "refund_policy_version"]);
});
