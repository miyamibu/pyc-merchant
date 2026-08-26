import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

test("terminal UI renders a dedicated Sites guide card with terms/privacy/refund/security links and a non-payment QR", () => {
  const html = read("public/terminal.html");
  const js = read("public/terminal.js");
  assert.match(html, /id="sitesGuideCard"/);
  assert.match(html, /決済用ではありません/);
  assert.match(html, /id="policyTermsLink"/);
  assert.match(html, /id="policyPrivacyLink"/);
  assert.match(html, /id="policyRefundLink"/);
  assert.match(html, /id="policySecurityLink"/);
  assert.match(html, /id="policyGuideQrCanvas"[^>]*aria-label="公開情報SiteのQR（決済用ではありません）"/);
  // The guide QR must be its own canvas, never the payment QR canvas.
  assert.match(js, /drawQr\(origin, el\.policyGuideQrCanvas\)/);
  // Origin-only HTTPS validation gates rendering (fail closed hides the card).
  assert.match(js, /function isOriginOnlyHttpsUrl\(/);
  assert.match(js, /parsed\.protocol === "https:"/);
  assert.match(js, /parsed\.port === ""/);
  assert.match(js, /host\.classList\.add\("hidden"\)/);
});

test("terminal UI records per-invoice policy consent before drawing the transfer QR", () => {
  const html = read("public/terminal.html");
  const js = read("public/terminal.js");
  assert.match(html, /id="invoiceConsentPanel"/);
  assert.match(html, /id="invoiceConsentCheckbox"/);
  assert.match(html, /利用規約・プライバシーポリシー・返金ポリシーを確認しました/);
  assert.match(html, /id="recordConsentBtn"/);

  // Client-side double gate: even if a URI were present, it is not drawn
  // while customer_policy_consent.recorded is false.
  assert.match(js, /const consentRecorded = consent\?\.recorded === true;/);
  assert.match(js, /const invoiceActive = Boolean\(invoice && walletUri\) && consentRecorded;/);
  assert.match(js, /規約同意の記録が完了していないため、送金QRは表示していません。/);
  assert.match(js, /\/api\/v1\/invoices\/\$\{encodeURIComponent\(invoiceId\)\}\/policy-consent/);
  assert.match(js, /terms_version: consent\.versions\.terms_version/);
  assert.match(js, /privacy_version: consent\.versions\.privacy_version/);
  assert.match(js, /refund_policy_version: consent\.versions\.refund_policy_version/);
  // Consent state resets with the invoice view and session.
  assert.match(js, /state\.invoiceConsent = null;/);
  assert.match(js, /renderSitesGuide\(\)/);
  assert.match(js, /public_policy_origin/);
});

test("server exposes the local-only staff consent endpoint and withholds wallet URIs until recorded", () => {
  const server = read("src/server.mjs");
  assert.match(server, /CREATE TABLE IF NOT EXISTS invoice_consents/);
  assert.match(server, /invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices\(id\)/);
  assert.match(server, /app\.post\("\/api\/v1\/invoices\/:invoiceId\/policy-consent"/);
  assert.match(server, /CONSENT_ENDPOINT_DISABLED_BY_TOPOLOGY/);
  assert.match(server, /customer_policy_consent_staff/);
  assert.match(server, /gateWalletPayloadForConsent/);
  assert.match(server, /payment_uri: null,\n    wallet_url: null,\n    wallet_deeplink: null,/);
  assert.match(server, /PUBLIC_POLICY_ORIGIN_EFFECTIVE/);
  assert.match(server, /public_policy_origin: PUBLIC_POLICY_ORIGIN \|\| null,/);
  assert.match(server, /refund_policy: `\$\{PUBLIC_POLICY_ORIGIN\}\/refund-policy`/);
  // The site-binding check must mark the non-local topology as "not
  // applicable" instead of returning a bare ok:true that could be misread as
  // a positive binding verification.
  assert.match(server, /applicable: false/);
});

test("launchd plists launch through the safe runner with a pinned Node 24.17.0 path and explicit .env.production", () => {
  for (const plist of [
    "deploy/launchd/com.jpyc.terminal.local.plist.example",
    "deploy/launchd/com.jpyc.chain-monitor.local.plist.example",
  ]) {
    const content = read(plist);
    assert.match(content, /__NODE24_BIN__/);
    assert.match(content, /v24\.17\.0/);
    assert.match(content, /run-env-safe\.mjs/);
    assert.match(content, /__REPO_DIR__\/\.env\.production/);
    assert.match(content, /--allow-exec/);
    assert.doesNotMatch(content, /__NODE_BIN__/);
  }
  const runner = read("deploy/launchd/run-env-safe.mjs");
  assert.match(runner, /PINNED_NODE_VERSION = "v24\.17\.0"/);
  assert.match(runner, /shell: false/);
  assert.match(runner, /env_file_mode_not_0600/);
  assert.match(runner, /TARGET_ALLOWLIST/);
  assert.match(runner, /child\.kill\(signal\)/);
  assert.match(runner, /process\.once\(signal, handler\)/);
});

test("env examples document PUBLIC_POLICY_ORIGIN and the fail-closed PUBLIC_PAYMENT_PAGE_ENABLED flag", () => {
  const devExample = read(".env.example");
  const prodExample = read(".env.production.example");
  for (const content of [devExample, prodExample]) {
    assert.match(content, /^PUBLIC_POLICY_ORIGIN=/m);
    assert.match(content, /^PUBLIC_PAYMENT_PAGE_ENABLED=true$/m);
    assert.match(content, /local_store_terminal must set this to false explicitly/);
  }
  const docs = read("docs/100-local-store-terminal-topology.md");
  assert.match(docs, /PUBLIC_PAYMENT_PAGE_ENABLED=false/);
  assert.match(docs, /PUBLIC_POLICY_ORIGIN/);
  assert.match(docs, /customer_policy_consent_staff/);
  assert.match(docs, /invoice_consents/);
});
