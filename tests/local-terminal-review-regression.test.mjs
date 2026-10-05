import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import Database from "better-sqlite3";
import { productionServerEnv, startServerProcess, stopServerProcess, loginAs, apiRequest, authHeaders, createInvoice, getInvoice } from "./helpers/server-process.mjs";
import { hashPolicyContent, POLICY_DOCUMENT_CONTRACT } from "../src/policy-publication.mjs";

test("login and bindings withhold unconsented transfers; only matching document versions create consent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jpyc-version-regression-"));
  const contents = Object.fromEntries(["terms", "privacy", "refund"].map((key) => [key,
    JSON.stringify({ title: key, version: "2026-08-26", summary: "Synthetic published policy", sections: [{ title: "Policy", paragraphs: ["Synthetic content only."] }] }),
  ]));
  const fixture = path.join(root, "pages.json");
  fs.writeFileSync(fixture, JSON.stringify(contents));
  const port = 22000 + process.pid % 15000;
  const origin = `http://127.0.0.1:${port}`;
  const publicOrigin = "https://miyamibu.xyz";
  const env = productionServerEnv({
    NODE_OPTIONS: "--import=./tests/helpers/mock-policy-site.mjs", POLICY_SITE_FIXTURE_PATH: fixture,
    APP_ENV: "development", DEPLOYMENT_STAGE: "development", COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_TOPOLOGY: "local_store_terminal", APP_PORT: String(port), APP_HOST: origin,
    PAY_BASE_URL: origin, CORS_ALLOW_ORIGINS: origin, PUBLIC_POLICY_ORIGIN: publicOrigin,
    PUBLIC_BASE_URL: publicOrigin, TRUST_PROXY: "false", TRUST_PROXY_HOPS: "",
    PUBLIC_PAYMENT_PAGE_ENABLED: "false", BACKUP_DIR: "./runtime/backups",
    LOCAL_TERMINAL_OPERATOR_READINESS_REF: "SYNTHETIC", RPC_URLS_137: "https://polygon-rpc.example.com",
    RECEIVE_ADDRESS_DEV_AUTO_VERIFY: "true",
  });
  const started = await startServerProcess(process.cwd(), env);
  t.after(async () => { await stopServerProcess(started.proc); fs.rmSync(root, { recursive: true, force: true }); });
  const admin = await loginAs(started.baseUrl, { terminalCode: env.TERMINAL_CODE, pin: env.STAFF_PIN, staffName: "Demo Staff" });
  const versions = (value) => ({ terms_version: value, privacy_version: value, refund_policy_version: value });
  const publish = async (value, key) => apiRequest(started.baseUrl, `/api/v1/admin/stores/${admin.storeId}/customer-policies`, {
    method: "PATCH", headers: authHeaders(admin.token, { "content-type": "application/json", "idempotency-key": key }),
    body: JSON.stringify({ terms_url: publicOrigin + "/terms", privacy_url: publicOrigin + "/privacy", refund_policy_url: publicOrigin + "/refund-policy",
      ...versions(value), terms_hash: hashPolicyContent(contents.terms), privacy_hash: hashPolicyContent(contents.privacy), refund_policy_hash: hashPolicyContent(contents.refund), contents }),
  });
  assert.equal((await publish("mistyped-2099", "version-mismatch")).status, 200);
  const created = await createInvoice(started.baseUrl, admin.token, 1880, "version-regression-invoice");
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.invoice_id;
  const dedicated = await getInvoice(started.baseUrl, admin.token, id);
  assert.equal(dedicated.data.amounts.token_amount_atomic, null);
  assert.equal(dedicated.data.chain.recipient_address, null);
  const binding = await apiRequest(started.baseUrl, `/api/v1/terminals/${admin.terminalId}/bindings`, { headers: authHeaders(admin.token) });
  assert.equal(binding.status, 200);
  const logout = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions/current", { method: "DELETE", headers: authHeaders(admin.token, { "idempotency-key": "version-regression-logout" }) });
  assert.equal(logout.status, 200);
  const login = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ terminalCode: env.TERMINAL_CODE, staffPin: env.STAFF_PIN, staffName: "Demo Staff" }) });
  assert.ok([200, 201].includes(login.status));
  for (const summary of [binding.data.terminal.current_invoice, login.data.current_invoice]) {
    assert.equal(summary.customer_policy_consent.recorded, false);
    assert.equal(summary.recipient_address, null);
    assert.equal(summary.token_amount_atomic, null);
    assert.equal(summary.amount_jpy, 1880, "operational amount remains visible");
  }
  const consent = (invoiceId, submitted) => apiRequest(started.baseUrl, `/api/v1/invoices/${invoiceId}/policy-consent`, {
    method: "POST", headers: authHeaders(login.data.token, { "content-type": "application/json" }), body: JSON.stringify(submitted),
  });
  const denied = await consent(id, versions("mistyped-2099"));
  assert.equal(denied.status, 503, JSON.stringify(denied.data));
  assert.equal(denied.data.error.code, "POLICY_SITE_CONTENT_UNVERIFIED");
  assert.deepEqual(denied.data.error.details.version_mismatch_keys, ["terms", "privacy", "refund"]);
  const db = new Database(env.DB_PATH);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM invoice_consents WHERE invoice_id=?").get(id).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='customer_policy_consent_staff' AND target_id=?").get(id).n, 0);
  // Login restored the original actor, so its still-valid earlier session can
  // administer a correction without mutating the frozen invoice snapshot.
  admin.token = login.data.token;
  assert.equal((await publish("2026-08-26", "version-corrected")).status, 200);
  const reissued = await apiRequest(started.baseUrl, `/api/v1/invoices/${id}/reissue`, { method: "POST", headers: authHeaders(login.data.token, { "content-type": "application/json", "idempotency-key": "version-reissue" }), body: "{}" });
  assert.equal(reissued.status, 201, JSON.stringify(reissued.data));
  const newId = reissued.data.invoice_id;
  const recorded = await consent(newId, versions("2026-08-26"));
  assert.equal(recorded.status, 201, JSON.stringify(recorded.data));
  const row = db.prepare("SELECT * FROM invoice_consents WHERE invoice_id=?").get(newId);
  assert.equal(row.site_content_contract, POLICY_DOCUMENT_CONTRACT);
  const after = await apiRequest(started.baseUrl, `/api/v1/terminals/${admin.terminalId}/bindings`, { headers: authHeaders(login.data.token) });
  assert.match(after.data.terminal.current_invoice.recipient_address, /^0x[0-9a-f]{40}$/i);
  assert.match(after.data.terminal.current_invoice.token_amount_atomic, /^\d+$/);
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='customer_policy_consent_staff' AND target_id=?").get(newId);
  // A v2 record is preserved as history, never silently upgraded to v3 proof.
  db.prepare("UPDATE invoice_consents SET site_content_contract='jpyc_policy_document_v2' WHERE invoice_id=?").run(newId);
  const legacyRow = db.prepare("SELECT * FROM invoice_consents WHERE invoice_id=?").get(newId);
  const legacy = await getInvoice(started.baseUrl, login.data.token, newId);
  assert.equal(legacy.data.customer_policy_consent.recorded, false);
  assert.equal(legacy.data.customer_policy_consent.requires_reissue, true);
  assert.equal(legacy.data.chain.recipient_address, null);
  const replay = await consent(newId, versions("2026-08-26"));
  assert.equal(replay.status, 409);
  assert.equal(replay.data.error.code, "POLICY_CONSENT_REISSUE_REQUIRED");
  assert.deepEqual(db.prepare("SELECT * FROM invoice_consents WHERE invoice_id=?").get(newId), legacyRow);
  assert.deepEqual(db.prepare("SELECT * FROM audit_logs WHERE action='customer_policy_consent_staff' AND target_id=?").get(newId), audit);
});

test("terminal summaries use the wallet lifecycle gate and preserve nonlocal responses", () => {
  const source = fs.readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  const fn = (name) => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  const invoice = { id: "synthetic", status: "issued", expires_at: "2099-01-01T00:00:00Z", recipient_address: "0x" + "2".repeat(40), token_amount_atomic: "1880000000000000000000", amount_jpy: 1880, payment_url: "https://legacy.merchant.jp/pay" };
  let consented = true;
  const summary = (local) => vm.runInNewContext(`${fn("gateWalletPayloadForConsent")}\n${fn("summarizeInvoiceForTerminalState")}\nsummarizeInvoiceForTerminalState`, {
    LOCAL_STORE_TERMINAL_TOPOLOGY: local, isLocalInvoiceConsented: () => consented,
    buildLocalConsentSummary: () => ({ recorded: consented }), findLatestReviewCase: () => null,
    buildAuthoritativeFulfillmentDecision: () => ({ decision: "allow" }), FULFILLMENT_DECISIONS: { ALLOW_FULFILLMENT: "allow" },
    deriveInvoiceStateAxes: () => ({}), AMOUNT_SCALE_VERSION: "v1", TOKEN_DECIMALS: 18, LEDGER_DECIMALS: 6,
  });
  const local = summary(true);
  assert.equal(local(invoice).recipient_address, invoice.recipient_address);
  for (const status of ["paid", "expired", "cancelled", "confirming", "review_required", "unknown_future_status"]) {
    const blocked = local({ ...invoice, status });
    assert.equal(blocked.recipient_address, null);
    assert.equal(blocked.token_amount_atomic, null);
    assert.equal(blocked.amount_jpy, invoice.amount_jpy);
  }
  for (const expires_at of ["2000-01-01T00:00:00Z", "invalid", null]) assert.equal(local({ ...invoice, expires_at }).recipient_address, null);
  consented = false;
  assert.equal(local(invoice).recipient_address, null);
  const legacy = summary(false)({ ...invoice, status: "paid" });
  assert.equal(legacy.recipient_address, invoice.recipient_address);
  assert.equal(legacy.token_amount_atomic, invoice.token_amount_atomic);
  assert.equal(legacy.payment_url, invoice.payment_url);
});
