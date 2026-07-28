import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
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

test("a new transfer after paid preserves the sale and opens duplicate review", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(process.cwd(), env);
  t.after(async () => stopServerProcess(started.proc));

  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const created = await createInvoice(started.baseUrl, staff.token, 1000, `duplicate-invoice-${Date.now()}`);
  assert.equal(created.status, 201);
  const firstBlockTimestamp = new Date(Date.now() - 1000).toISOString();

  const firstTx = randomTxHash("duplicate-original");
  const first = await ingestManualPayment(
    started.baseUrl,
    staff.token,
    {
      invoice_id: created.data.invoice_id,
      amount_jpyc: 1000,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: firstTx,
      log_index: 0,
      block_number: 100,
      block_timestamp: firstBlockTimestamp,
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    `duplicate-original-${Date.now()}`,
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.status, "paid");

  const afterFirst = await getInvoice(started.baseUrl, staff.token, created.data.invoice_id);
  assert.equal(afterFirst.status, 200);
  const originalPaidBase = String(afterFirst.data.amounts.paid_amount_jpyc_base);
  assert.equal(afterFirst.data.status, "paid");
  assert.equal(afterFirst.data.events[0].tx_hash, firstTx);

  const second = await ingestManualPayment(
    started.baseUrl,
    staff.token,
    {
      invoice_id: created.data.invoice_id,
      amount_jpyc: 1000,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("duplicate-after-paid"),
      log_index: 1,
      block_number: 101,
      block_timestamp: firstBlockTimestamp,
      from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    `duplicate-after-paid-${Date.now()}`,
  );
  assert.equal(second.status, 200);
  assert.equal(second.data.status, "review_required");
  assert.equal(second.data.review_required, true);

  const afterSecond = await getInvoice(started.baseUrl, staff.token, created.data.invoice_id);
  assert.equal(afterSecond.status, 200);
  assert.equal(afterSecond.data.status, "review_required");
  assert.equal(String(afterSecond.data.amounts.paid_amount_jpyc_base), originalPaidBase);
  assert.equal(afterSecond.data.events.find((event) => event.tx_hash === firstTx).tx_hash, firstTx);

  const reviews = await fetch(`${started.baseUrl}/api/v1/reviews`, {
    headers: authHeaders(staff.token),
  });
  assert.equal(reviews.status, 200);
  const review = (await reviews.json()).reviews.find((item) => item.invoice_id === created.data.invoice_id);
  assert.equal(review.reason_code, "DUPLICATE_PAYMENT");
});

test("one chain transfer linked to two invoices is a global collision hold", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(process.cwd(), env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const first = await createInvoice(started.baseUrl, staff.token, 1000, `collision-first-${Date.now()}`);
  assert.equal(first.status, 201);
  const sharedTx = randomTxHash("cross-invoice-transfer");
  const firstPayment = await ingestManualPayment(
    started.baseUrl,
    staff.token,
    {
      invoice_id: first.data.invoice_id,
      amount_jpyc: 1000,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: sharedTx,
      log_index: 0,
      block_number: 200,
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    `collision-first-payment-${Date.now()}`,
  );
  assert.equal(firstPayment.status, 200);
  assert.equal(firstPayment.data.status, "paid");

  const second = await createInvoice(started.baseUrl, staff.token, 1000, `collision-second-${Date.now()}`);
  assert.equal(second.status, 201);
  const secondPayment = await ingestManualPayment(
    started.baseUrl,
    staff.token,
    {
      invoice_id: second.data.invoice_id,
      amount_jpyc: 1000,
      chain_id: "0137",
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: sharedTx.toUpperCase(),
      log_index: "00",
      block_number: 200,
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    `collision-second-payment-${Date.now()}`,
  );
  assert.equal(secondPayment.status, 200, JSON.stringify(secondPayment.data));
  assert.equal(secondPayment.data.status, "review_required");
  assert.equal(secondPayment.data.review_required, true);

  const transfers = db.prepare("SELECT chain_id, tx_hash, log_index, integrity_status FROM blockchain_transfers WHERE lower(tx_hash) = lower(?)").all(sharedTx);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].chain_id, "137");
  assert.equal(transfers[0].integrity_status, "disputed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transfer_observations WHERE blockchain_transfer_id = (SELECT id FROM blockchain_transfers WHERE tx_hash = ?)").get(sharedTx).count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_transfer_links WHERE blockchain_transfer_id = (SELECT id FROM blockchain_transfers WHERE tx_hash = ?)").get(sharedTx).count, 2);
  const held = db.prepare("SELECT id, integrity_hold_reason FROM invoices WHERE id IN (?, ?) ORDER BY id").all(first.data.invoice_id, second.data.invoice_id);
  assert.equal(held.length, 2);
  assert.deepEqual(new Set(held.map((row) => row.integrity_hold_reason)), new Set(["CROSS_INVOICE_TRANSFER_COLLISION"]));
});
