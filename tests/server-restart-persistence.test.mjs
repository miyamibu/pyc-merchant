import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  baseServerEnv,
  createInvoice,
  getInvoice,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("SR-17 confirming invoice survives server restart without reverting to paid or issued", async (t) => {
  const env = baseServerEnv();
  const first = await startServerProcess(CWD, env);

  let second = null;
  t.after(async () => {
    if (second) await stopServerProcess(second.proc);
    await stopServerProcess(first.proc);
  });

  const admin = await loginAs(first.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });

  const created = await createInvoice(first.baseUrl, admin.token, 1550, `restart-invoice-${Date.now()}`);
  assert.equal(created.status, 201);

  const db = new Database(env.DB_PATH);
  const txHash = "0x" + "a".repeat(64);
  try {
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO payment_events
      (id, invoice_id, event_type, chain_id, tx_hash, log_index, block_number, confirmations, from_address, to_address, token_contract, amount_jpyc, amount_jpyc_base, observed_at, raw_payload, created_at)
      VALUES (?, ?, 'tx_detected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `evt-${Date.now()}`,
      created.data.invoice_id,
      env.CHAIN_ID,
      txHash,
      0,
      0,
      1,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      env.RECIPIENT_ADDRESS,
      env.TOKEN_CONTRACT,
      1550,
      "1550000000",
      ts,
      JSON.stringify({ synthetic: true, confirming: true }),
      ts
    );
    db.prepare(
      `UPDATE invoices
       SET status = 'confirming',
           status_reason = 'awaiting_confirmations',
           paid_amount_jpyc = 1550,
           paid_amount_jpyc_base = 1550000000,
           paid_tx_hash = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(txHash, ts, created.data.invoice_id);
  } finally {
    db.close();
  }

  const beforeRestart = await getInvoice(first.baseUrl, admin.token, created.data.invoice_id);
  assert.equal(beforeRestart.status, 200);
  assert.equal(beforeRestart.data.status, "confirming");
  assert.ok(beforeRestart.data.events.some((row) => row.tx_hash === txHash));

  await stopServerProcess(first.proc);
  second = await startServerProcess(CWD, env);

  const adminAfterRestart = await loginAs(second.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const afterRestart = await getInvoice(second.baseUrl, adminAfterRestart.token, created.data.invoice_id);
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.data.status, "confirming");
  assert.equal(afterRestart.data.status_reason, "awaiting_confirmations");
  assert.equal(afterRestart.data.amounts.paid_amount_jpyc_base, beforeRestart.data.amounts.paid_amount_jpyc_base);
  assert.equal(afterRestart.data.events.length, beforeRestart.data.events.length);
});

test("SR-18 terminal public token and current invoice pointer survive server restart", async (t) => {
  const env = baseServerEnv();
  const first = await startServerProcess(CWD, env);

  let second = null;
  t.after(async () => {
    if (second) await stopServerProcess(second.proc);
    await stopServerProcess(first.proc);
  });

  const admin = await loginAs(first.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const created = await createInvoice(first.baseUrl, admin.token, 1660, `restart-fixed-entry-${Date.now()}`);
  assert.equal(created.status, 201);
  assert.equal(created.data.fixed_qr_url, admin.fixedQrUrl);

  const db = new Database(env.DB_PATH);
  try {
    const terminal = db
      .prepare(`SELECT public_entry_token, current_invoice_id FROM terminals WHERE id = ?`)
      .get(admin.terminalId);
    assert.equal(terminal.public_entry_token, admin.publicEntryToken);
    assert.equal(terminal.current_invoice_id, created.data.invoice_id);
  } finally {
    db.close();
  }

  await stopServerProcess(first.proc);
  second = await startServerProcess(CWD, env);

  const adminAfterRestart = await loginAs(second.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  assert.equal(adminAfterRestart.publicEntryToken, admin.publicEntryToken);
  assert.equal(adminAfterRestart.fixedQrUrl, admin.fixedQrUrl);

  const entryAfterRestart = await apiRequest(
    second.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(adminAfterRestart.publicEntryToken)}`
  );
  assert.equal(entryAfterRestart.status, 200);
  assert.equal(entryAfterRestart.data.status, "ready");
  assert.equal(entryAfterRestart.data.active_invoice.invoice_id, created.data.invoice_id);
});
