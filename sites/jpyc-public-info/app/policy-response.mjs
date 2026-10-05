import { pages, POLICY_PAGE_VERSIONS } from './content.ts';
import { POLICY_DOCUMENT_HEADERS, renderPolicyDocument } from './policy-document.mjs';

export function policyResponse(slug) {
  const page = pages.find((entry) => entry.slug === slug);
  if (!['terms', 'privacy', 'refund-policy'].includes(slug) || !page) return new Response(null, { status: 404 });
  const content = JSON.stringify({ title: page.title, version: POLICY_PAGE_VERSIONS[slug], summary: page.summary, sections: page.sections });
  return new Response(renderPolicyDocument(content), { headers: POLICY_DOCUMENT_HEADERS });
}
