import { createHash } from 'node:crypto';

// Contract v2 accepts only this self-contained document, never arbitrary HTML.
// The API regenerates the entire document and compares its UTF-8 bytes.
export const POLICY_DOCUMENT_CONTRACT = 'jpyc_policy_document_v2';
const style = 'body{margin:0;background:#fff;color:#172033;font:18px/1.7 system-ui,sans-serif}main{max-width:52rem;margin:auto;padding:2rem 1rem}h1{font-size:2rem}h2{font-size:1.4rem}section{margin:2rem 0}li{margin:.5rem 0}.notice{border:2px solid #172033;padding:1rem}';
const styleHash = createHash('sha256').update(style, 'utf8').digest('base64');
export const POLICY_DOCUMENT_CSP = `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export const POLICY_DOCUMENT_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': POLICY_DOCUMENT_CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
});
const dataOpen = '<script id="policy-content" type="application/json">';
const text = (value) => typeof value === 'string' && value.trim().length > 0
  && value.length <= 16_000 && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));
const list = (value) => Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every(text);
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');

export function parsePolicyDocumentContent(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 64_000) return null;
  try {
    const page = JSON.parse(content);
    if (!exactKeys(page, ['title', 'summary', 'sections']) || !text(page.title) || !text(page.summary)
      || !Array.isArray(page.sections) || page.sections.length === 0 || page.sections.length > 128) return null;
    const sections = [];
    for (const section of page.sections) {
      if (!exactKeys(section, ['title', 'paragraphs', 'bullets']) || !text(section.title)
        || (!Object.hasOwn(section, 'paragraphs') && !Object.hasOwn(section, 'bullets'))
        || (Object.hasOwn(section, 'paragraphs') && !list(section.paragraphs))
        || (Object.hasOwn(section, 'bullets') && !list(section.bullets))) return null;
      sections.push({ title: section.title,
        ...(section.paragraphs ? { paragraphs: section.paragraphs } : {}),
        ...(section.bullets ? { bullets: section.bullets } : {}),
      });
    }
    const canonical = JSON.stringify({ title: page.title, summary: page.summary, sections });
    return canonical === content ? page : null;
  } catch { return null; }
}

export function renderPolicyDocument(content) {
  const page = parsePolicyDocumentContent(content);
  if (!page) throw new Error('unsupported policy document content');
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  const data = content.replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const sections = page.sections.map((section) => `<section><h2>${escape(section.title)}</h2>`
    + (section.paragraphs || []).map((value) => `<p>${escape(value)}</p>`).join('')
    + (section.bullets ? `<ul>${section.bullets.map((value) => `<li>${escape(value)}</li>`).join('')}</ul>` : '')
    + '</section>').join('');
  const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<meta name="policy-contract" content="${POLICY_DOCUMENT_CONTRACT}"><meta http-equiv="Content-Security-Policy" content="${escape(POLICY_DOCUMENT_CSP)}">`
    + `<title>${escape(page.title)}</title><style>${style}</style></head><body><main id="main">`
    + '<p class="notice">このSiteから送金しないでください。支払いは店舗端末に表示されたQRからのみ行います。</p>'
    + `<header class="document-hero"><h1>${escape(page.title)}</h1><p>${escape(page.summary)}</p></header>`
    + `<article class="document-body" data-policy-sha256="${digest}">${sections}</article></main>`
    + `${dataOpen}${data}</script></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > 256_000) throw new Error('policy document too large');
  return html;
}

// Read the structured payload only to regenerate the document. Acceptance
// requires full equality, so extra/hidden elements, CSS, scripts and replicas
// cannot be silently ignored. This does not infer visibility from arbitrary DOM.
export function extractPolicyDocumentContent(html) {
  if (typeof html !== 'string') return null;
  const start = html.indexOf(dataOpen);
  if (start < 0 || html.indexOf(dataOpen, start + dataOpen.length) !== -1) return null;
  const end = html.indexOf('</script>', start + dataOpen.length);
  if (end < 0) return null;
  try {
    const content = JSON.stringify(JSON.parse(html.slice(start + dataOpen.length, end)));
    return renderPolicyDocument(content) === html ? content : null;
  } catch { return null; }
}
