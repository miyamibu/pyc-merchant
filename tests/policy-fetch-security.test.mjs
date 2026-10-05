import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fetchPublishedPolicyPage, verifyPublishedPolicyPages, hashPolicyContent } from '../src/policy-publication.mjs';
import { createPinnedLookup, fetchPinnedPublicHttps } from '../src/public-endpoint-security.mjs';
import { POLICY_DOCUMENT_HEADERS, renderPolicyDocument } from '../sites/jpyc-public-info/app/policy-document.mjs';

test('policy HTTPS rejects non-public/mixed DNS and DNS failure before opening any socket', async (t) => {
  let requests = 0;
  t.mock.method(https, 'request', () => { requests++; throw new Error('must not request'); });
  let answers;
  t.mock.method(dns, 'lookup', async () => {
    if (answers instanceof Error) throw answers;
    return answers;
  });
  for (const result of [
    [{ address: '127.0.0.1' }], [{ address: '10.0.0.1' }], [{ address: '169.254.169.254' }],
    [{ address: '1.1.1.1' }, { address: '::1' }], [{ address: '::ffff:127.0.0.1' }],
    [{ address: '3fff::1' }], [{ address: '4000::1' }], [], new Error('ENOTFOUND'),
  ]) {
    answers = result;
    await assert.rejects(fetchPublishedPolicyPage('https://policy.attacker.jp/terms'));
  }
  assert.equal(requests, 0);
  assert.throws(() => createPinnedLookup('policies.merchant.jp', ['1.1.1.1', '127.0.0.1']));
  for (const url of ['https://policies.merchant.jp:8443/terms', 'http://policies.merchant.jp/terms']) await assert.rejects(fetchPublishedPolicyPage(url));
  await assert.rejects(fetchPinnedPublicHttps('https://policies.merchant.jp/terms', { timeoutMs: 10, lookup: () => new Promise(() => {}) }), /dns_timeout/);
  assert.equal(requests, 0);
});

test('policy HTTPS pins validated DNS with TLS hostname checks, a fresh socket, size limit and zero redirects', async (t) => {
  const content = JSON.stringify({ title: 'Terms', version: '2026-08-26', summary: 'Original summary', sections: [{ title: 'Fees', paragraphs: ['No extra fee.'] }] });
  const html = renderPolicyDocument(content);
  let status = 200;
  let body = html;
  let lookups = 0;
  let requests = 0;
  t.mock.method(dns, 'lookup', async (hostname, options) => {
    lookups++;
    assert.equal(hostname, 'policies.merchant.jp');
    assert.deepEqual(options, { all: true, verbatim: true });
    return [{ address: '1.1.1.1', family: 4 }];
  });
  t.mock.method(https, 'request', (url, options, callback) => {
    requests++;
    assert.equal(url.protocol, 'https:');
    assert.equal(options.servername, url.hostname);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    assert.equal(options.autoSelectFamily, false);
    options.lookup(url.hostname, { family: 4 }, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '1.1.1.1');
      assert.equal(family, 4);
    });
    const request = new EventEmitter();
    request.destroy = (error) => { if (error) request.emit('error', error); request.emit('close'); };
    request.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = { ...POLICY_DOCUMENT_HEADERS, ...(status === 302 ? { location: 'https://other.merchant.jp/' } : {}) };
      response.on('close', () => request.emit('close'));
      callback(response);
      response.end(body);
    });
    return request;
  });
  const response = await fetchPublishedPolicyPage('https://policies.merchant.jp/terms');
  assert.equal(await response.text(), html);
  assert.equal(lookups, 1, 'the pinned connect does not resolve again');
  status = 302;
  await assert.rejects(fetchPublishedPolicyPage('https://policies.merchant.jp/terms'), /redirect_limit_exceeded/);
  assert.equal(requests, 2, 'redirect never opens a second destination');
  status = 200;
  body = 'x'.repeat(256_001);
  await assert.rejects(fetchPublishedPolicyPage('https://policies.merchant.jp/terms'), /response_too_large/);
  body = Buffer.from([0xff]);
  const urls = { terms: 'https://policies.merchant.jp/terms', privacy: 'https://policies.merchant.jp/privacy', refund: 'https://policies.merchant.jp/refund-policy' };
  const hashes = { terms_hash: hashPolicyContent(content), privacy_hash: hashPolicyContent(content), refund_policy_hash: hashPolicyContent(content) };
  const expectedVersions = { terms_version: '2026-08-26', privacy_version: '2026-08-26', refund_policy_version: '2026-08-26' };
  assert.deepEqual((await verifyPublishedPolicyPages(urls, hashes, { expectedVersions })).unavailable_keys, ['terms', 'privacy', 'refund']);
});
