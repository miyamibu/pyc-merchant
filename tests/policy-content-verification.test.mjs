import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { hashPolicyContent } from "../src/policy-publication.mjs";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  loginAs,
  parsePaymentUrl,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("customer policy update verifies exact content hashes before consent snapshots are usable", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const contents = {
    terms: "JPYC Merchant Terms\nVersion: 2026-07-25\n",
    privacy: "プライバシーポリシー\nVersion: 2026-07-25\n",
    refund: "Refund policy\r\nVersion: 2026-07-25\r\n",
  };
  const versions = {
    terms_version: "2026-07-25",
    privacy_version: "2026-07-25",
    refund_policy_version: "2026-07-25",
  };
  const payload = {
    terms_url: "https://policies.merchant.jp/legal/terms",
    privacy_url: "https://policies.merchant.jp/legal/privacy",
    refund_policy_url: "https://policies.merchant.jp/legal/refund",
    ...versions,
    terms_hash: hashPolicyContent(contents.terms),
    privacy_hash: hashPolicyContent(contents.privacy),
    refund_policy_hash: hashPolicyContent(contents.refund),
    contents,
  };

  const mismatch = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/customer-policies`,
    {
      method: "PATCH",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `policy-mismatch-${Date.now()}`,
      }),
      body: JSON.stringify({ ...payload, refund_policy_hash: "f".repeat(64) }),
    }
  );
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.data.error.code, "POLICY_PUBLICATION_INVALID");
  assert.deepEqual(mismatch.data.error.details.mismatch_hash_keys, ["refund_policy_hash"]);
  assert.equal(db.prepare(`SELECT terms_hash FROM stores WHERE id = ?`).get(admin.storeId).terms_hash, null);

  const updated = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/customer-policies`,
    {
      method: "PATCH",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `policy-valid-${Date.now()}`,
      }),
      body: JSON.stringify(payload),
    }
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.data.policy.ok, true);
  assert.equal(updated.data.policy.content_verification.ok, true);
  assert.deepEqual(updated.data.policy.content_verification.computed_hashes, {
    terms_hash: payload.terms_hash,
    privacy_hash: payload.privacy_hash,
    refund_policy_hash: payload.refund_policy_hash,
  });
  assert.doesNotMatch(JSON.stringify(updated.data), /JPYC Merchant Terms|プライバシーポリシー/);

  const invoice = await createInvoice(started.baseUrl, admin.token, 500, `policy-invoice-${Date.now()}`);
  assert.equal(invoice.status, 201);
  const signed = parsePaymentUrl(invoice.data.payment_url);
  const consent = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}/consent?sig=${encodeURIComponent(signed.sig)}&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(versions),
    }
  );
  assert.equal(consent.status, 200);

  const consentAudit = db.prepare(
    `SELECT after_state FROM audit_logs WHERE action = 'customer_policy_consent' AND target_id = ? ORDER BY rowid DESC LIMIT 1`
  ).get(invoice.data.invoice_id);
  assert.ok(consentAudit?.after_state);
  assert.deepEqual(JSON.parse(consentAudit.after_state).policy_hashes, {
    terms_hash: payload.terms_hash,
    privacy_hash: payload.privacy_hash,
    refund_policy_hash: payload.refund_policy_hash,
  });
});

test("an invoice without an issuance-time policy snapshot cannot inherit a later store policy", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const invoice = await createInvoice(started.baseUrl, admin.token, 700, `legacy-policy-invoice-${Date.now()}`);
  assert.equal(invoice.status, 201);
  const signed = parsePaymentUrl(invoice.data.payment_url);

  const contents = {
    terms: "Later terms\n",
    privacy: "Later privacy\n",
    refund: "Later refund policy\n",
  };
  const versions = {
    terms_version: "2026-07-26",
    privacy_version: "2026-07-26",
    refund_policy_version: "2026-07-26",
  };
  const update = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/customer-policies`,
    {
      method: "PATCH",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `later-policy-${Date.now()}`,
      }),
      body: JSON.stringify({
        terms_url: "https://policies.merchant.jp/legal/terms-v2",
        privacy_url: "https://policies.merchant.jp/legal/privacy-v2",
        refund_policy_url: "https://policies.merchant.jp/legal/refund-v2",
        ...versions,
        terms_hash: hashPolicyContent(contents.terms),
        privacy_hash: hashPolicyContent(contents.privacy),
        refund_policy_hash: hashPolicyContent(contents.refund),
        contents,
      }),
    }
  );
  assert.equal(update.status, 200);

  const publicInvoice = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}?sig=${encodeURIComponent(signed.sig)}&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`
  );
  assert.equal(publicInvoice.status, 200);
  assert.equal(publicInvoice.data.policy_urls, null);
  assert.equal(publicInvoice.data.policy_versions, null);
  assert.equal(publicInvoice.data.policy_hashes, null);

  const consent = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}/consent?sig=${encodeURIComponent(signed.sig)}&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(versions),
    }
  );
  assert.equal(consent.status, 503);
  assert.equal(consent.data.error.code, "POLICY_CONFIGURATION_NOT_READY");
  assert.equal(consent.data.error.details.snapshot_missing, true);
});
