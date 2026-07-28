import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  ingestManualPayment,
  loginAs,
  parsePaymentUrl,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("fixed terminal QR waits, resolves to the current invoice once, and blocks a second active invoice", async (t) => {
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
    staffName: "Demo Staff",
  });

  assert.ok(admin.publicEntryToken);
  assert.match(String(admin.fixedQrUrl || ""), /\/t\//);

  const waitingEntry = await fetch(`${started.baseUrl}/t/${encodeURIComponent(admin.publicEntryToken)}`, {
    redirect: "manual",
  });
  assert.equal(waitingEntry.status, 302);
  assert.match(String(waitingEntry.headers.get("location") || ""), /\/terminal-entry\.html\?token=/);

  const waitingState = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}`
  );
  assert.equal(waitingState.status, 200);
  assert.equal(waitingState.data.status, "waiting");

  const created = await createInvoice(started.baseUrl, admin.token, 1880, `fixed-entry-${Date.now()}`);
  assert.equal(created.status, 201);
  assert.equal(created.data.fixed_qr_url, admin.fixedQrUrl);

  const readyState = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}`
  );
  assert.equal(readyState.status, 200);
  assert.equal(readyState.data.status, "ready");
  assert.equal(readyState.data.active_invoice.invoice_id, created.data.invoice_id);
  assert.equal(readyState.data.pay_url, created.data.payment_url);

  const claimPayload = readyState.data.active_invoice;
  const claimBody = {
    anonymous_device_id: "device-fixed-qr-test-001",
    nonce: "nonce-fixed-qr-test-0001",
    invoice_version: claimPayload.invoice_version,
    amount_scale_version: claimPayload.amount_scale_version,
    token_amount_atomic: claimPayload.token_amount_atomic,
    ledger_amount_base: claimPayload.ledger_amount_base,
  };
  const claim = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}/claim`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(claimBody) }
  );
  assert.equal(claim.status, 201);
  assert.equal(claim.data.invoice_id, created.data.invoice_id);
  assert.equal(claim.data.claim_status, "claimed");
  assert.equal(claim.data.pay_url, undefined);

  const consumedClaim = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}/claim/${encodeURIComponent(claim.data.claim_id)}/consume`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(claimBody) }
  );
  assert.equal(consumedClaim.status, 201);
  assert.equal(consumedClaim.data.claim_status, "consumed");
  assert.equal(consumedClaim.data.pay_url, created.data.payment_url);

  const replayClaim = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}/claim`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(claimBody) }
  );
  assert.equal(replayClaim.status, 201);
  assert.equal(replayClaim.data.claim_id, claim.data.claim_id);
  assert.equal(replayClaim.data.claim_status, "consumed");

  const conflictingClaim = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}/claim`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...claimBody,
        anonymous_device_id: "device-fixed-qr-test-002",
        nonce: "nonce-fixed-qr-test-0002",
      }),
    }
  );
  assert.equal(conflictingClaim.status, 409);
  assert.equal(conflictingClaim.data.error.code, "CHECKOUT_ALREADY_CLAIMED");

  const directEntry = await fetch(`${started.baseUrl}/t/${encodeURIComponent(admin.publicEntryToken)}`, {
    redirect: "manual",
  });
  assert.equal(directEntry.status, 302);
  assert.match(String(directEntry.headers.get("location") || ""), /\/terminal-entry\.html\?token=/);

  const parsed = parsePaymentUrl(created.data.payment_url);
  assert.equal(parsed.invoiceId, created.data.invoice_id);

  const blocked = await createInvoice(started.baseUrl, admin.token, 1990, `fixed-entry-blocked-${Date.now()}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.code, "TERMINAL_ACTIVE_INVOICE_EXISTS");
  assert.equal(blocked.data.error.details.active_invoice.invoice_id, created.data.invoice_id);

  const terminalRow = db
    .prepare(`SELECT public_entry_token, current_invoice_id FROM terminals WHERE id = ?`)
    .get(admin.terminalId);
  assert.equal(terminalRow.public_entry_token, admin.publicEntryToken);
  assert.equal(terminalRow.current_invoice_id, created.data.invoice_id);

  const expired = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}/expire`,
    {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `fixed-entry-expire-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(expired.status, 200);

  const afterExpireState = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}`
  );
  assert.equal(afterExpireState.status, 200);
  assert.equal(afterExpireState.data.status, "waiting");

  const pointerAfterExpire = db.prepare(`SELECT current_invoice_id FROM terminals WHERE id = ?`).get(admin.terminalId);
  assert.equal(pointerAfterExpire.current_invoice_id, null);
});

test("reissue swaps the terminal current invoice pointer and late payment on the old invoice still falls to review", async (t) => {
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
    staffName: "Demo Staff",
  });

  const original = await createInvoice(started.baseUrl, admin.token, 2222, `fixed-reissue-${Date.now()}`);
  assert.equal(original.status, 201);

  const reissued = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(original.data.invoice_id)}/reissue`,
    {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `fixed-reissue-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(reissued.status, 201);
  assert.equal(reissued.data.fixed_qr_url, admin.fixedQrUrl);
  assert.notEqual(reissued.data.invoice_id, original.data.invoice_id);

  const pointerRow = db.prepare(`SELECT current_invoice_id FROM terminals WHERE id = ?`).get(admin.terminalId);
  assert.equal(pointerRow.current_invoice_id, reissued.data.invoice_id);

  const entryAfterReissue = await fetch(`${started.baseUrl}/t/${encodeURIComponent(admin.publicEntryToken)}`, {
    redirect: "manual",
  });
  assert.equal(entryAfterReissue.status, 302);
  assert.match(String(entryAfterReissue.headers.get("location") || ""), /\/terminal-entry\.html\?token=/);
  const entryStateAfterReissue = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}`
  );
  assert.equal(entryStateAfterReissue.status, 200);
  assert.equal(entryStateAfterReissue.data.status, "ready");
  assert.equal(entryStateAfterReissue.data.pay_url, reissued.data.payment_url);

  const oldInvoice = await getInvoice(started.baseUrl, admin.token, original.data.invoice_id);
  assert.equal(oldInvoice.status, 200);
  assert.equal(oldInvoice.data.status, "expired");
  assert.equal(parsePaymentUrl(oldInvoice.data.payment_url).invoiceId, original.data.invoice_id);

  const lateToOldInvoice = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: original.data.invoice_id,
      amount_jpyc: 2222,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("fixed-old-late"),
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      observed_at: new Date(Date.now() + 1000).toISOString(),
      block_timestamp: new Date(Date.parse(original.data.expires_at) + 1000).toISOString(),
    },
    `fixed-old-late-${Date.now()}`
  );
  assert.equal(lateToOldInvoice.status, 200);
  assert.equal(lateToOldInvoice.data.status, "review_required");

  const oldAfterLate = await getInvoice(started.baseUrl, admin.token, original.data.invoice_id);
  const newAfterLate = await getInvoice(started.baseUrl, admin.token, reissued.data.invoice_id);
  assert.equal(oldAfterLate.status, 200);
  assert.equal(newAfterLate.status, 200);
  assert.equal(oldAfterLate.data.status, "review_required");
  assert.equal(oldAfterLate.data.status_reason, "late_arrival_after_expiry");
  assert.equal(newAfterLate.data.status, "issued");

  const reviewRow = db.prepare(`SELECT reason_type FROM review_cases WHERE invoice_id = ?`).get(original.data.invoice_id);
  assert.equal(reviewRow.reason_type, "LATE_PAYMENT");

  const pointerAfterLate = db.prepare(`SELECT current_invoice_id FROM terminals WHERE id = ?`).get(admin.terminalId);
  assert.equal(pointerAfterLate.current_invoice_id, reissued.data.invoice_id);
});

test("fixed QR claim is invalidated when the invoice version changes before consume", async (t) => {
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
    staffName: "Demo Staff",
  });
  const created = await createInvoice(started.baseUrl, admin.token, 1550, `fixed-claim-version-${Date.now()}`);
  assert.equal(created.status, 201);
  const entry = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}`
  );
  assert.equal(entry.status, 200);
  const current = entry.data.active_invoice;
  const claimBody = {
    anonymous_device_id: "device-fixed-qr-version-001",
    nonce: "nonce-fixed-qr-version-0001",
    invoice_version: current.invoice_version,
    amount_scale_version: current.amount_scale_version,
    token_amount_atomic: current.token_amount_atomic,
    ledger_amount_base: current.ledger_amount_base,
  };
  const claim = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}/claim`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(claimBody) }
  );
  assert.equal(claim.status, 201);
  db.prepare("UPDATE invoices SET invoice_version = COALESCE(invoice_version, 1) + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), created.data.invoice_id);

  const currentEntry = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}`
  );
  assert.equal(currentEntry.status, 200);
  const currentBody = {
    ...claimBody,
    invoice_version: currentEntry.data.active_invoice.invoice_version,
    amount_scale_version: currentEntry.data.active_invoice.amount_scale_version,
    token_amount_atomic: currentEntry.data.active_invoice.token_amount_atomic,
    ledger_amount_base: currentEntry.data.active_invoice.ledger_amount_base,
  };
  const staleClaimWithLatestValues = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}/claim/${encodeURIComponent(claim.data.claim_id)}/consume`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(currentBody) }
  );
  assert.equal(staleClaimWithLatestValues.status, 409);
  assert.equal(staleClaimWithLatestValues.data.error.code, "CHECKOUT_CLAIM_STALE");

  const consumed = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}/claim/${encodeURIComponent(claim.data.claim_id)}/consume`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(claimBody) }
  );
  assert.equal(consumed.status, 409);
  assert.equal(consumed.data.error.code, "CHECKOUT_CLAIM_STALE");
});
