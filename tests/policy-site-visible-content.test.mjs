import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pages } from "../sites/jpyc-public-info/app/content.ts";
import { extractVisiblePolicyContent, hashPolicyContent } from "../src/policy-publication.mjs";

const slugs = { terms: "terms", privacy: "privacy", refund: "refund-policy" };
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
import { GET as termsGet } from "../sites/jpyc-public-info/app/terms/route.ts";
import { GET as privacyGet } from "../sites/jpyc-public-info/app/privacy/route.ts";
import { GET as refundGet } from "../sites/jpyc-public-info/app/refund-policy/route.ts";
const routes = { terms: termsGet, privacy: privacyGet, refund: refundGet };
import { renderPolicyDocument } from "../sites/jpyc-public-info/app/policy-document.mjs";

test("policy export hashes the same visible title, summary, and sections used by all three Site pages", async () => {
  const exported = JSON.parse(execFileSync(process.execPath, ["sites/jpyc-public-info/scripts/policy-snapshot.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }));
  for (const [key, slug] of Object.entries(slugs)) {
    const page = pages.find((candidate) => candidate.slug === slug);
    assert.ok(page);
    const expected = JSON.stringify({ title: page.title, summary: page.summary, sections: page.sections });
    const hashKey = key === "refund" ? "refund_policy_hash" : `${key}_hash`;
    assert.equal(exported.contents[key], expected);
    assert.equal(exported[hashKey], hashPolicyContent(expected));
    const visiblePage = await routes[key]().text();
    assert.equal(visiblePage, renderPolicyDocument(expected));
    assert.equal(extractVisiblePolicyContent(visiblePage), expected);

    const firstVisibleText = page.sections[0].paragraphs?.[0] || page.sections[0].bullets?.[0];
    const changedPage = visiblePage.replace(escape(firstVisibleText), "Changed visible policy text");
    assert.notEqual(hashPolicyContent(extractVisiblePolicyContent(changedPage)), exported[hashKey]);
    assert.match(changedPage, new RegExp(`data-policy-sha256="${exported[hashKey]}"`));
  }
});
