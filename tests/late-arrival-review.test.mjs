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
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("SR-18 expired invoice does not become paid and records LATE_PAYMENT review reason", async (t) => {
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

  const created = await createInvoice(started.baseUrl, admin.token, 1110, `late-arrival-${Date.now()}`);
  assert.equal(created.status, 201);

  const expire = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}/expire`,
    {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `late-expire-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(expire.status, 200);
  assert.equal(expire.data.status, "expired");

  const latePayment = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: created.data.invoice_id,
      amount_jpyc: 1110,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("late-arrival"),
      from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      observed_at: new Date(Date.now() + 1000).toISOString(),
    },
    `late-pay-${Date.now()}`
  );
  assert.equal(latePayment.status, 200);
  assert.equal(latePayment.data.status, "review_required");

  const detail = await getInvoice(started.baseUrl, admin.token, created.data.invoice_id);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.status, "review_required");
  assert.equal(detail.data.status_reason, "late_arrival_after_expiry");

  const review = db.prepare(`SELECT reason_type, status FROM review_cases WHERE invoice_id = ?`).get(created.data.invoice_id);
  assert.equal(review.reason_type, "LATE_PAYMENT");
  assert.equal(review.status, "open");
});
