import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const hosting = JSON.parse(read('.openai/hosting.json'));
assert.equal(hosting.d1, null, 'D1 must remain disabled');
assert.equal(hosting.r2, null, 'R2 must remain disabled');
assert.deepEqual(
  Object.keys(hosting).sort(),
  hosting.project_id ? ['d1', 'project_id', 'r2'] : ['d1', 'r2'],
  'hosting metadata may contain only project_id and null D1/R2 bindings',
);

const sourceFiles = [
  'app/page.tsx',
  'app/layout.tsx',
  'app/site-shell.tsx',
  'app/content.ts',
  'app/[slug]/page.tsx',
  'app/policy-document.mjs',
  'app/policy-response.mjs',
  'app/terms/route.ts',
  'app/privacy/route.ts',
  'app/refund-policy/route.ts',
];
const source = sourceFiles.map((path) => read(path)).join('\n');
assert.match(read('app/policy-response.mjs'), /renderPolicyDocument\(content\)/);
for (const slug of ['terms', 'privacy', 'refund-policy']) {
  assert.match(read(`app/${slug}/route.ts`), new RegExp(`policyResponse\\('${slug}'\\)`));
}

for (const forbidden of [
  /APP_SECRET/i,
  /SERVICE_INGEST_SECRET/i,
  /METRICS_SECRET/i,
  /OPENAI_API_KEY/i,
  /WalletConnect/i,
  /window\.ethereum/i,
  /ethereum:/i,
  /eip-681/i,
  /0x[0-9a-f]{40}/i,
  /<form\b/i,
  /<input\b/i,
  /<button\b/i,
]) {
  assert.doesNotMatch(source, forbidden, `forbidden public Site pattern: ${forbidden}`);
}

const expectedRoutes = [
  'payment-guide',
  'terms',
  'privacy',
  'refund-policy',
  'faq',
  'contact',
  'security',
  'version',
];
for (const route of expectedRoutes) {
  assert.match(source, new RegExp(`slug: ['\"]${route}['\"]`), `missing route content: /${route}`);
}

for (const requiredCopy of [
  'このSiteから送金しないでください',
  '店舗端末',
  'Polygon',
  'JPYC',
  '非カストディ',
  '秘密鍵',
  'シードフレーズ',
  '返金は自動実行ではありません',
]) {
  assert.match(source, new RegExp(requiredCopy), `missing required safety copy: ${requiredCopy}`);
}

const publicFiles = readdirSync(new URL('public', root));
assert(publicFiles.includes('favicon.svg'), 'favicon.svg must exist');
console.log(`Sites static validation passed: ${sourceFiles.length} source files, ${expectedRoutes.length + 1} routes`);
