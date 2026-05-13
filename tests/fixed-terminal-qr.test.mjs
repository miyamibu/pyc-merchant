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

  const directEntry = await fetch(`${started.baseUrl}/t/${encodeURIComponent(admin.publicEntryToken)}`, {
    redirect: "manual",
  });
  assert.equal(directEntry.status, 302);
  assert.equal(directEntry.headers.get("location"), created.data.payment_url);

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
  assert.equal(entryAfterReissue.headers.get("location"), reissued.data.payment_url);

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
