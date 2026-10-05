import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { hashPolicyContent, verifyPublishedPolicyPages, extractVisiblePolicyContent } from '../src/policy-publication.mjs';
import { POLICY_DOCUMENT_HEADERS, renderPolicyDocument } from '../sites/jpyc-public-info/app/policy-document.mjs';
import { buildEip681PaymentUri } from '../src/wallet-adapter.mjs';

// Same synthetic policy data and attack transformations as the independent
// review. Contract v3 adds a version-bound positive case.
const urls = { terms: 'https://policies.merchant.jp/terms', privacy: 'https://policies.merchant.jp/privacy', refund: 'https://policies.merchant.jp/refund-policy' };
const contents = {
  terms: JSON.stringify({ title: 'Terms', version: '2026-08-26', summary: 'Original summary', sections: [{ title: 'Fees', paragraphs: ['No extra fee.'] }] }),
  privacy: JSON.stringify({ title: 'Privacy', version: '2026-08-26', summary: 'Original summary', sections: [{ title: 'Data', paragraphs: ['No sharing.'] }] }),
  refund: JSON.stringify({ title: 'Refund', version: '2026-08-26', summary: 'Original summary', sections: [{ title: 'Refunds', bullets: ['Ask staff.'] }] }),
};
const hashes = { terms_hash: hashPolicyContent(contents.terms), privacy_hash: hashPolicyContent(contents.privacy), refund_policy_hash: hashPolicyContent(contents.refund) };
const expectedVersions = { terms_version: '2026-08-26', privacy_version: '2026-08-26', refund_policy_version: '2026-08-26' };
const base = Object.fromEntries(Object.entries(contents).map(([key, content]) => [key, renderPolicyDocument(content)]));
const verify = (terms, headers = POLICY_DOCUMENT_HEADERS) => verifyPublishedPolicyPages(urls, hashes, {
  expectedVersions,
  fetchImpl: async (url) => new Response(url === urls.terms ? terms : base[Object.keys(urls).find((key) => urls[key] === url)], { headers }),
});

test('independent F1: contract-v3 baseline succeeds and every visible/hidden addition fails closed', async (t) => {
  assert.equal((await verify(base.terms)).ok, true);
  assert.equal(extractVisiblePolicyContent(base.terms), contents.terms);
  for (const [name, html] of [
    ['heading_changed', base.terms.replace('<h1>Terms</h1>', '<h1>Altered terms</h1>')],
    ['summary_changed', base.terms.replace('<p>Original summary</p>', '<p>Altered summary</p>')],
    ['section_heading_changed', base.terms.replace('<h2>Fees</h2>', '<h2>Hidden fees</h2>')],
    ['section_body_changed', base.terms.replace('<p>No extra fee.</p>', '<p>A large fee applies.</p>')],
    ['extra_visible_hero_paragraph', base.terms.replace('</p></header>', '</p><p class="new-policy">A large fee applies.</p></header>')],
    ['extra_visible_main_section', base.terms.replace('</article></main>', '</article><section><h2>New fees</h2><p>A large fee applies.</p></section></main>')],
    ['hidden_replica_visible_replacement', base.terms.replace('<main id="main">', '<main id="main" hidden>') + '<main id="main"><p>Different terms</p></main>'],
    ['in_article_extra_text', base.terms.replace('</section>', '<p>Extra charge</p></section>')],
    ['hidden_article', base.terms.replace('<article class=', '<article hidden class=')],
    ['injected_style', base.terms.replace('</head>', '<style>article{display:none}</style></head>')],
    ['injected_script', base.terms.replace('</body>', '<script>document.body.textContent="Different terms"</script></body>')],
    ['detached_marker', base.terms.replace(` data-policy-sha256="${hashes.terms_hash}"`, '') + `<article data-policy-sha256="${hashes.terms_hash}"></article>`],
    ['trailing_whitespace', base.terms + ' '],
  ]) await t.test(name, async () => {
    const result = await verify(html);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unavailable_keys, ['terms']);
  });
  const changed = JSON.parse(contents.terms);
  changed.sections[0].paragraphs[0] = 'A large fee applies.';
  assert.deepEqual((await verify(renderPolicyDocument(JSON.stringify(changed)))).mismatch_keys, ['terms']);
  const legacy = `<main id="main"><header class="document-hero"><h1>Terms</h1><p>Original summary</p></header><article class="document-body" data-policy-sha256="${hashes.terms_hash}"><section><h2>Fees</h2><p>No extra fee.</p></section></article></main>`;
  assert.equal((await verify(legacy)).ok, false, 'previous partial-HTML contract is retired');
});

test('document safety headers and strict content schema are mandatory', async () => {
  for (const headers of [
    { ...POLICY_DOCUMENT_HEADERS, refresh: '0;url=https://other.merchant.jp/' },
    { ...POLICY_DOCUMENT_HEADERS, 'content-security-policy': "default-src *" },
    { ...POLICY_DOCUMENT_HEADERS, 'cache-control': 'public, max-age=86400' },
    { 'content-type': 'text/html; charset=utf-8' },
  ]) assert.equal((await verify(base.terms, headers)).ok, false);
  assert.equal((await verify('\uFEFF' + base.terms)).ok, false, 'a UTF-8 BOM cannot be silently stripped before full comparison');
  for (const content of [
    contents.terms + ' ',
    JSON.stringify({ ...JSON.parse(contents.terms), hidden: true }),
    JSON.stringify({ title: 'Terms', version: '2026-08-26', summary: 'Summary', sections: [{ title: 'Fees', html: '<p>Different</p>' }] }),
  ]) assert.throws(() => renderPolicyDocument(content));
  const escaped = JSON.stringify({ title: '<script>&"', version: '2026-08-26', summary: 'Summary', sections: [{ title: 'Fees', paragraphs: ['</script><style>hidden</style>'] }] });
  assert.equal(extractVisiblePolicyContent(renderPolicyDocument(escaped)), escaped);
});

test('independent F3: blocked payload and diagnostics cannot reconstruct the transfer URI', () => {
  const source = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const fn = (name) => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  const gateSource = fn('gateWalletPayloadForConsent');
  assert.ok(gateSource);
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  class FixedDate extends Date { static now() { return now; } }
  let consented = true;
  const payload = {
    payment_uri: 'ethereum:0x1111111111111111111111111111111111111111@137/transfer?address=0x2222222222222222222222222222222222222222&uint256=1000000000000000000',
    wallet_url: 'wallet://pay', wallet_deeplink: 'wallet://pay', copy_fallback: { copy_receive_address: '0x2222222222222222222222222222222222222222' },
    chain_id: '137', token_contract: '0x1111111111111111111111111111111111111111', receive_address: '0x2222222222222222222222222222222222222222', expected_amount_atomic: '1000000000000000000',
    unrecognized_transfer_information: 'must not survive',
  };
  const gate = vm.runInNewContext(`${gateSource}\ngateWalletPayloadForConsent`, {
    LOCAL_STORE_TERMINAL_TOPOLOGY: true, Date: FixedDate, isLocalInvoiceConsented: () => consented,
  });
  const future = '2026-10-04T12:00:00.001Z';
  assert.equal(gate(payload, { status: 'issued', expires_at: future }).payment_uri, payload.payment_uri);
  for (const status of ['payment_detected', 'confirming', 'paid', 'settled', 'refunded', 'review_required', 'expired', 'cancelled', 'unknown_future_status']) {
    const blocked = gate(payload, { status, expires_at: future });
    for (const field of ['payment_uri', 'wallet_url', 'wallet_deeplink', 'copy_fallback', 'chain_id', 'token_contract', 'receive_address', 'expected_amount_atomic']) assert.equal(blocked[field], null, `${status}:${field}`);
    assert.equal(blocked.unrecognized_transfer_information, undefined);
    assert.equal(buildEip681PaymentUri({ chainId: blocked.chain_id, tokenContract: blocked.token_contract, receiveAddress: blocked.receive_address, expectedAmountAtomic: blocked.expected_amount_atomic }), null);
  }
  for (const expires_at of ['2026-10-04T12:00:00.000Z', '2026-10-04T11:59:59.999Z', 'invalid']) assert.equal(gate(payload, { status: 'issued', expires_at }).receive_address, null);
  consented = false;
  assert.equal(gate(payload, { status: 'issued', expires_at: future }).receive_address, null);

  const diagnostics = vm.runInNewContext(`${fn('getReissueRootInvoiceId')}\n${fn('listInvoiceReissueHistory')}\n${gateSource}\n${fn('buildInvoiceDiagnostics')}\nbuildInvoiceDiagnostics`, {
    LOCAL_STORE_TERMINAL_TOPOLOGY: true, Date: FixedDate, isLocalInvoiceConsented: () => true,
    buildInvoiceWalletPayload: () => payload, nowIso: () => 'fixture', computeTtlRemainingSec: () => 0,
    db: { prepare: () => ({ all: () => [{ id: 'old', recipient_address: payload.receive_address, payment_url: 'https://private-payment-link/' }] }) },
  });
  const result = diagnostics({ id: 'closed', status: 'paid', expires_at: future, payment_url: 'https://private-payment-link/' });
  assert.equal(result.receive_address, null);
  assert.equal(result.expected_amount_atomic, null);
  assert.equal(result.payment_url, null);
  assert.equal(result.reissue.history[0].receive_address, null);
  assert.equal(JSON.stringify(result).includes(payload.receive_address), false);
});
