import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  loginAs,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";
import { buildServiceAuthHeaders } from "./helpers/service-auth.mjs";

const CWD = process.cwd();

async function startFixture(t) {
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
  return { env, started, db, admin };
}

async function createInvoiceFixture(fixture, amount, seed) {
  const created = await createInvoice(
    fixture.started.baseUrl,
    fixture.admin.token,
    amount,
    `${seed}-invoice-${Date.now()}`
  );
  assert.equal(created.status, 201);
  const invoice = fixture.db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(created.data.invoice_id);
  assert.ok(invoice);
  return invoice;
}

async function ingestFromChainMonitor(fixture, payload, seed) {
  const idempotencyKey = `${seed}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return apiRequest(fixture.started.baseUrl, "/api/v1/internal/payments/events:ingest", {
    method: "POST",
    headers: buildServiceAuthHeaders(fixture.env, payload, idempotencyKey),
    body: JSON.stringify(payload),
  });
}

function chainPayload(fixture, invoice, overrides = {}) {
  return {
    invoice_id: invoice.id,
    amount_jpyc: String(invoice.amount_jpyc),
    amount_jpyc_base: String(invoice.amount_jpyc_base),
    chain_id: fixture.env.CHAIN_ID,
    token_contract: fixture.env.TOKEN_CONTRACT,
    to_address: invoice.recipient_address,
    from_address: "0x6000000000000000000000000000000000000001",
    confirmations: 2,
    tx_hash: randomTxHash("chain-monitor-exactness"),
    log_index: 0,
    block_number: 123,
    block_hash: `0x${"b".repeat(64)}`,
    block_timestamp: new Date().toISOString(),
    detected_at: new Date().toISOString(),
    source: "chain_monitor",
    ...overrides,
  };
}

test("internal chain ingest fails closed when canonical_status is absent", async (t) => {
  const fixture = await startFixture(t);
  const invoice = await createInvoiceFixture(fixture, 1200, "canonical-unknown");
  const canonicalColumn = fixture.db
    .prepare(`PRAGMA table_info(payment_events)`)
    .all()
    .find((column) => column.name === "canonical_status");
  assert.equal(canonicalColumn?.dflt_value, "'unknown'");
  const payload = chainPayload(fixture, invoice);
  assert.equal(Object.hasOwn(payload, "canonical_status"), false);

  const ingested = await ingestFromChainMonitor(fixture, payload, "canonical-unknown-ingest");
  assert.equal(ingested.status, 200);
  assert.equal(ingested.data.status, "review_required");
  assert.equal(ingested.data.review_required, true);

  const event = fixture.db
    .prepare(`SELECT canonical_status, recognition_status FROM payment_events WHERE invoice_id = ? AND tx_hash = ?`)
    .get(invoice.id, payload.tx_hash);
  assert.equal(event.canonical_status, "unknown");
  assert.equal(event.recognition_status, "review_required");
  const review = fixture.db.prepare(`SELECT status FROM review_cases WHERE invoice_id = ?`).get(invoice.id);
  assert.equal(review.status, "open");
});

test("non-exact 18-to-6 transfer keeps amount_atomic and routes the matched invoice to review", async (t) => {
  const fixture = await startFixture(t);
  const invoice = await createInvoiceFixture(fixture, 1500, "non-exact");
  const amountAtomic = `${BigInt(String(invoice.amount_jpyc_base)) * 10n ** 12n + 1n}`;
  const payload = chainPayload(fixture, invoice, {
    canonical_status: "canonical",
    amount_atomic: amountAtomic,
    token_decimals: 18,
    ledger_decimals: 6,
    amount_conversion_exact: false,
    amount_conversion_error: "non_exact_decimal_conversion",
  });

  const ingested = await ingestFromChainMonitor(fixture, payload, "non-exact-ingest");
  assert.equal(ingested.status, 200);
  assert.equal(ingested.data.invoice_id, invoice.id);
  assert.equal(ingested.data.status, "review_required");
  assert.equal(ingested.data.review_required, true);

  const event = fixture.db
    .prepare(`SELECT amount_atomic, recognition_status, raw_payload FROM payment_events WHERE invoice_id = ? AND tx_hash = ?`)
    .get(invoice.id, payload.tx_hash);
  assert.equal(event.amount_atomic, amountAtomic);
  assert.equal(event.recognition_status, "review_required");
  const rawPayload = JSON.parse(event.raw_payload);
  assert.equal(rawPayload.amount_conversion_exact, false);
  assert.equal(rawPayload.amount_conversion_error, "non_exact_decimal_conversion");

  const repeated = await ingestFromChainMonitor(
    fixture,
    { ...payload, confirmations: 3 },
    "non-exact-confirmation-update"
  );
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.duplicate, true);
  const repeatedEvent = fixture.db
    .prepare(`SELECT recognition_status FROM payment_events WHERE invoice_id = ? AND tx_hash = ?`)
    .get(invoice.id, payload.tx_hash);
  assert.equal(repeatedEvent.recognition_status, "review_required");
  const eventCount = fixture.db
    .prepare(`SELECT COUNT(*) AS count FROM payment_events WHERE invoice_id = ? AND tx_hash = ?`)
    .get(invoice.id, payload.tx_hash);
  assert.equal(Number(eventCount.count), 1);

  const heldInvoice = fixture.db
    .prepare(`SELECT status, integrity_hold, integrity_hold_reason FROM invoices WHERE id = ?`)
    .get(invoice.id);
  assert.equal(heldInvoice.status, "review_required");
  assert.equal(Number(heldInvoice.integrity_hold), 1);
  assert.equal(heldInvoice.integrity_hold_reason, "non_exact_decimal_conversion");
  const review = fixture.db.prepare(`SELECT status FROM review_cases WHERE invoice_id = ?`).get(invoice.id);
  assert.equal(review.status, "open");
});

test("chain payment to a cancelled invoice is retained as an invoice-linked review", async (t) => {
  const fixture = await startFixture(t);
  const invoice = await createInvoiceFixture(fixture, 900, "cancelled-old-address");
  const cancelled = await apiRequest(
    fixture.started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(invoice.id)}/cancel`,
    {
      method: "POST",
      headers: authHeaders(fixture.admin.token, {
        "content-type": "application/json",
        "idempotency-key": `cancelled-old-address-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, "cancelled");

  const payload = chainPayload(fixture, invoice, {
    canonical_status: "canonical",
    amount_atomic: `${BigInt(String(invoice.amount_jpyc_base)) * 10n ** 12n}`,
    token_decimals: 18,
    ledger_decimals: 6,
    amount_conversion_exact: true,
    amount_conversion_error: null,
  });
  const ingested = await ingestFromChainMonitor(fixture, payload, "cancelled-old-address-ingest");
  assert.equal(ingested.status, 200);
  assert.equal(ingested.data.invoice_id, invoice.id);
  assert.equal(ingested.data.status, "review_required");
  assert.equal(ingested.data.review_required, true);

  const event = fixture.db
    .prepare(`SELECT invoice_id FROM payment_events WHERE tx_hash = ?`)
    .get(payload.tx_hash);
  assert.equal(event.invoice_id, invoice.id);
  const reviewedInvoice = fixture.db.prepare(`SELECT status, status_reason FROM invoices WHERE id = ?`).get(invoice.id);
  assert.equal(reviewedInvoice.status, "review_required");
  assert.equal(reviewedInvoice.status_reason, "payment_after_cancelled_invoice");
  const review = fixture.db.prepare(`SELECT status, reason_type FROM review_cases WHERE invoice_id = ?`).get(invoice.id);
  assert.equal(review.status, "open");
  assert.equal(review.reason_type, "LATE_PAYMENT");
});
