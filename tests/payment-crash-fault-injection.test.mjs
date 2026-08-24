import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  ingestManualPayment,
  loginAs,
  productionServerEnv,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

function paymentPayload(invoiceId, env, txHash = randomTxHash("crash-fault")) {
  return {
    invoice_id: invoiceId,
    amount_jpyc: 1000,
    chain_id: env.CHAIN_ID,
    token_contract: env.TOKEN_CONTRACT,
    to_address: env.RECIPIENT_ADDRESS,
    confirmations: 2,
    tx_hash: txHash,
    log_index: 0,
    block_number: 123,
    block_timestamp: new Date(Date.now() - 1000).toISOString(),
    from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

function waitForExit(proc, timeoutMs = 8_000) {
  if (proc.exitCode != null || proc.signalCode != null) {
    return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function readFinancialState(dbPath, invoiceId) {
  const db = new Database(dbPath);
  try {
    const invoice = db.prepare(
      `SELECT status, paid_tx_hash, paid_amount_jpyc_base, primary_recognized_transfer_id
       FROM invoices WHERE id = ?`
    ).get(invoiceId);
    const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE invoice_id = ?`).get(invoiceId).count;
    return {
      invoice,
      payment_events: count("payment_events"),
      payment_attempts: count("payment_attempts"),
      notification_outbox: count("payment_notification_outbox"),
      accounting_events: count("accounting_event_journal"),
      transfer_links: count("invoice_transfer_links"),
    };
  } finally {
    db.close();
  }
}

function readOutbox(dbPath, invoiceId) {
  const db = new Database(dbPath);
  try {
    return db.prepare(
      `SELECT id, status, attempt_count, lease_owner, lease_expires_at, sent_at
       FROM payment_notification_outbox
       WHERE invoice_id = ?
       ORDER BY created_at ASC, id ASC LIMIT 1`
    ).get(invoiceId);
  } finally {
    db.close();
  }
}

async function waitForOutboxStatus(dbPath, invoiceId, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    while (Date.now() < deadline) {
      try {
        const row = db.prepare(
          `SELECT id, status, attempt_count, lease_owner, lease_expires_at, sent_at
           FROM payment_notification_outbox
           WHERE invoice_id = ?
           ORDER BY created_at ASC, id ASC LIMIT 1`
        ).get(invoiceId);
        if (row?.status === expectedStatus) return row;
      } catch (_error) {
        // A concurrent SQLite write is expected during this polling assertion.
      }
      await delay(100);
    }
  } finally {
    db.close();
  }
  throw new Error(`outbox did not reach status=${expectedStatus} for invoice=${invoiceId}`);
}

async function openInvoiceStream(baseUrl, staffToken, terminalId, invoiceId) {
  const tokenResponse = await apiRequest(
    baseUrl,
    `/api/v1/invoices/${encodeURIComponent(invoiceId)}/sse-token`,
    { method: "POST", headers: authHeaders(staffToken) },
  );
  assert.equal(tokenResponse.status, 200, JSON.stringify(tokenResponse.data));
  const controller = new AbortController();
  const stream = await fetch(
    `${baseUrl}/api/v1/streams/terminals/${encodeURIComponent(terminalId)}?invoice_id=${encodeURIComponent(invoiceId)}&sse_token=${encodeURIComponent(tokenResponse.data.token)}`,
    { signal: controller.signal },
  );
  assert.equal(stream.status, 200);
  return {
    stream,
    close() {
      controller.abort();
    },
  };
}

function spawnServerForStartupCheck(env) {
  const output = [];
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: CWD,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => output.push(String(chunk)));
  proc.stderr.on("data", (chunk) => output.push(String(chunk)));
  return { proc, output };
}

test("production-like startup rejects test-only crash fault injection", async () => {
  const env = productionServerEnv({
    TEST_CRASH_FAULT_INJECTION: "payment_transaction_before_commit",
  });
  const started = spawnServerForStartupCheck(env);
  const exit = await waitForExit(started.proc);
  assert.equal(exit.code, 1);
  assert.equal(exit.signal, null);
  assert.match(started.output.join(""), /TEST_CRASH_FAULT_INJECTION is disabled in production-like runtime/);
});

test("transaction crash rolls back financial writes and restart safely reprocesses payment", async (t) => {
  const env = baseServerEnv({
    TEST_CRASH_FAULT_INJECTION: "payment_transaction_before_commit",
  });
  const first = await startServerProcess(CWD, env);
  let restarted = null;
  t.after(async () => {
    if (restarted) await stopServerProcess(restarted.proc);
    await stopServerProcess(first.proc);
  });

  const staff = await loginAs(first.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const created = await createInvoice(first.baseUrl, staff.token, 1000, `crash-tx-${Date.now()}`);
  assert.equal(created.status, 201);
  const payload = paymentPayload(created.data.invoice_id, env);
  const request = ingestManualPayment(first.baseUrl, staff.token, payload, `crash-tx-payment-${Date.now()}`).catch(() => null);
  const exit = await waitForExit(first.proc);
  await request;
  assert.equal(exit.signal, "SIGKILL");

  const afterCrash = readFinancialState(env.DB_PATH, created.data.invoice_id);
  assert.deepEqual(afterCrash.invoice, {
    status: "issued",
    paid_tx_hash: null,
    paid_amount_jpyc_base: 0,
    primary_recognized_transfer_id: null,
  });
  assert.equal(afterCrash.payment_events, 0);
  assert.equal(afterCrash.payment_attempts, 0);
  assert.equal(afterCrash.notification_outbox, 0);
  assert.equal(afterCrash.accounting_events, 0);
  assert.equal(afterCrash.transfer_links, 0);

  restarted = await startServerProcess(CWD, { ...env, TEST_CRASH_FAULT_INJECTION: "" });
  const staffAfterRestart = await loginAs(restarted.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const retry = await ingestManualPayment(
    restarted.baseUrl,
    staffAfterRestart.token,
    payload,
    `crash-tx-retry-${Date.now()}`,
  );
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.status, "paid");

  const detail = await getInvoice(restarted.baseUrl, staffAfterRestart.token, created.data.invoice_id);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.status, "paid");
  assert.equal(detail.data.events.length, 1);
  assert.equal(detail.data.events[0].tx_hash, payload.tx_hash);
});

test("commit crash leaves committed outbox pending and restart dispatches it", async (t) => {
  const env = baseServerEnv({
    TEST_CRASH_FAULT_INJECTION: "payment_commit_before_outbox_dispatch",
  });
  const first = await startServerProcess(CWD, env);
  let restarted = null;
  let stream = null;
  t.after(async () => {
    if (stream) stream.close();
    if (restarted) await stopServerProcess(restarted.proc);
    await stopServerProcess(first.proc);
  });

  const staff = await loginAs(first.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const created = await createInvoice(first.baseUrl, staff.token, 1000, `crash-commit-${Date.now()}`);
  assert.equal(created.status, 201);
  const payload = paymentPayload(created.data.invoice_id, env);
  const request = ingestManualPayment(first.baseUrl, staff.token, payload, `crash-commit-payment-${Date.now()}`).catch(() => null);
  const exit = await waitForExit(first.proc);
  await request;
  assert.equal(exit.signal, "SIGKILL");

  const afterCrash = readFinancialState(env.DB_PATH, created.data.invoice_id);
  assert.equal(afterCrash.invoice.status, "paid");
  assert.equal(afterCrash.payment_events, 1);
  assert.equal(afterCrash.payment_attempts, 1);
  assert.equal(afterCrash.notification_outbox, 1);
  const pending = readOutbox(env.DB_PATH, created.data.invoice_id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.attempt_count, 0);
  assert.equal(pending.lease_owner, null);
  assert.equal(pending.lease_expires_at, null);

  restarted = await startServerProcess(CWD, { ...env, TEST_CRASH_FAULT_INJECTION: "" });
  const staffAfterRestart = await loginAs(restarted.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  stream = await openInvoiceStream(
    restarted.baseUrl,
    staffAfterRestart.token,
    staffAfterRestart.terminalId,
    created.data.invoice_id,
  );
  const sent = await waitForOutboxStatus(env.DB_PATH, created.data.invoice_id, "sent", 8_000);
  assert.equal(sent.attempt_count, 1);
  assert.ok(sent.sent_at);
});

test("dispatch crash leaves a leased outbox row that restart reclaims and retries", async (t) => {
  const env = baseServerEnv({
    TEST_CRASH_FAULT_INJECTION: "payment_outbox_after_lease_claim",
    NOTIFICATION_OUTBOX_LEASE_SEC: "5",
  });
  const first = await startServerProcess(CWD, env);
  let restarted = null;
  let stream = null;
  t.after(async () => {
    if (stream) stream.close();
    if (restarted) await stopServerProcess(restarted.proc);
    await stopServerProcess(first.proc);
  });

  const staff = await loginAs(first.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const created = await createInvoice(first.baseUrl, staff.token, 1000, `crash-lease-${Date.now()}`);
  assert.equal(created.status, 201);
  const payload = paymentPayload(created.data.invoice_id, env);
  const request = ingestManualPayment(first.baseUrl, staff.token, payload, `crash-lease-payment-${Date.now()}`).catch(() => null);
  const exit = await waitForExit(first.proc);
  await request;
  assert.equal(exit.signal, "SIGKILL");

  const afterCrash = readFinancialState(env.DB_PATH, created.data.invoice_id);
  assert.equal(afterCrash.invoice.status, "paid");
  const leased = readOutbox(env.DB_PATH, created.data.invoice_id);
  assert.equal(leased.status, "processing");
  assert.equal(leased.attempt_count, 1);
  assert.ok(leased.lease_owner);
  assert.ok(leased.lease_expires_at);

  restarted = await startServerProcess(CWD, { ...env, TEST_CRASH_FAULT_INJECTION: "" });
  const staffAfterRestart = await loginAs(restarted.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  stream = await openInvoiceStream(
    restarted.baseUrl,
    staffAfterRestart.token,
    staffAfterRestart.terminalId,
    created.data.invoice_id,
  );
  const sent = await waitForOutboxStatus(env.DB_PATH, created.data.invoice_id, "sent", 13_000);
  assert.equal(sent.attempt_count, 2);
  assert.equal(sent.lease_owner, null);
  assert.ok(sent.sent_at);
});
