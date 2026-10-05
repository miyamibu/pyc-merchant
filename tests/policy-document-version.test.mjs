import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hashPolicyContent, verifyPublishedPolicyPages } from "../src/policy-publication.mjs";
import { POLICY_DOCUMENT_HEADERS, renderPolicyDocument, extractPolicyDocumentContent, POLICY_DOCUMENT_CONTRACT } from "../sites/jpyc-public-info/app/policy-document.mjs";

const urls = { terms: "https://policies.merchant.jp/terms", privacy: "https://policies.merchant.jp/privacy", refund: "https://policies.merchant.jp/refund-policy" };
const keys = { terms: "terms_version", privacy: "privacy_version", refund: "refund_policy_version" };
const versions = { terms_version: "terms-1", privacy_version: "privacy-2", refund_policy_version: "refund-3" };
const contents = Object.fromEntries(Object.keys(urls).map((key) => [key, JSON.stringify({ title: key, version: versions[keys[key]], summary: "Published policy", sections: [{ title: "Policy", paragraphs: ["Synthetic content."] }] })]));
const hashes = { terms_hash: hashPolicyContent(contents.terms), privacy_hash: hashPolicyContent(contents.privacy), refund_policy_hash: hashPolicyContent(contents.refund) };
const pages = Object.fromEntries(Object.entries(contents).map(([key, content]) => [key, renderPolicyDocument(content)]));
const fetchImpl = async (url) => new Response(pages[Object.keys(urls).find((key) => urls[key] === url)], { headers: POLICY_DOCUMENT_HEADERS });

test("published document versions must match each frozen invoice version independently", async () => {
  assert.equal(POLICY_DOCUMENT_CONTRACT, "jpyc_policy_document_v3");
  assert.equal((await verifyPublishedPolicyPages(urls, hashes, { expectedVersions: versions, fetchImpl })).ok, true);
  for (const key of Object.keys(urls)) {
    const result = await verifyPublishedPolicyPages(urls, hashes, { expectedVersions: { ...versions, [keys[key]]: "mistyped-2099" }, fetchImpl });
    assert.equal(result.ok, false);
    assert.deepEqual(result.version_mismatch_keys, [key]);
    assert.deepEqual(result.mismatch_keys, [], "valid hashes cannot prove an unrelated version");
  }
});

test("missing or invalid expected versions fail before fetch; old two-argument callers cannot certify consent", async () => {
  for (const expectedVersions of [undefined, {}, { ...versions, terms_version: "" }, { ...versions, terms_version: "draft-v1" }]) {
    let calls = 0;
    const result = await verifyPublishedPolicyPages(urls, hashes, { expectedVersions, fetchImpl: async (url) => { calls++; return fetchImpl(url); } });
    assert.equal(result.ok, false);
    assert.ok(result.unavailable_keys.includes("terms"));
    assert.equal(calls, expectedVersions && Object.hasOwn(expectedVersions, "privacy_version") ? 2 : 0);
  }
});

test("version is visible, escaped, canonical and hash-bound; versionless v2 publication is rejected", async () => {
  const changed = { ...JSON.parse(contents.terms), version: "terms-2" };
  const changedContent = JSON.stringify(changed);
  assert.notEqual(hashPolicyContent(changedContent), hashes.terms_hash);
  const altered = pages.terms.replace('data-policy-version="terms-1">文書版: terms-1', 'data-policy-version="terms-1">文書版: terms-2');
  assert.equal(extractPolicyDocumentContent(altered), null);
  const escapedContent = JSON.stringify({ ...JSON.parse(contents.terms), version: '版-1<>&"' });
  const escaped = renderPolicyDocument(escapedContent);
  assert.ok(escaped.includes('文書版: 版-1&lt;&gt;&amp;&quot;'));
  assert.equal(extractPolicyDocumentContent(escaped), escapedContent);
  for (const version of [undefined, null, "", " 1 ", "x".repeat(129), "pending-1", { version: "1" }]) {
    assert.throws(() => renderPolicyDocument(JSON.stringify({ ...JSON.parse(contents.terms), version })));
  }
  const legacy = fs.readFileSync(new URL("./fixtures/policy-document-v2.html", import.meta.url), "utf8");
  assert.ok(legacy.includes('content="jpyc_policy_document_v2"'));
  assert.equal(extractPolicyDocumentContent(legacy), null);
  const result = await verifyPublishedPolicyPages(urls, hashes, { expectedVersions: versions, fetchImpl: async () => new Response(legacy, { headers: POLICY_DOCUMENT_HEADERS }) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unavailable_keys, ["terms", "privacy", "refund"]);
});
