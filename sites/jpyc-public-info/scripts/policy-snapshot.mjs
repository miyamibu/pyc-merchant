// Run with Node 24's built-in TypeScript stripping. The exact strings emitted
// here are the store policy bodies; the public pages hash the same page data.
import { createHash } from 'node:crypto';
import { pages, POLICY_PAGE_VERSIONS } from '../app/content.ts';
import { renderPolicyDocument } from '../app/policy-document.mjs';

const slugs = { terms: 'terms', privacy: 'privacy', refund: 'refund-policy' };
const contents = {};
const hashes = {};
const versions = {};
for (const [key, slug] of Object.entries(slugs)) {
  const page = pages.find((entry) => entry.slug === slug);
  if (!page) throw new Error(`missing policy page: ${slug}`);
  const version = POLICY_PAGE_VERSIONS[slug];
  const content = JSON.stringify({ title: page.title, version, summary: page.summary, sections: page.sections });
  renderPolicyDocument(content); // Reject unsupported policy bodies at export.
  contents[key] = content;
  versions[key === 'refund' ? 'refund_policy_version' : `${key}_version`] = version;
  hashes[key === 'refund' ? 'refund_policy_hash' : `${key}_hash`] = createHash('sha256').update(content, 'utf8').digest('hex');
}
console.log(JSON.stringify({ contents, ...versions, ...hashes }, null, 2));
