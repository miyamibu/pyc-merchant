import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const TOKEN_CONTRACT = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
const OLD_ADDRESS = "0x5000000000000000000000000000000000000101";
const NEW_ADDRESS = "0x5000000000000000000000000000000000000102";

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function loadMonitorModule() {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-monitor-exactness-"));
  const env = {
    APP_ENV: "development",
    APP_HOST: "http://127.0.0.1:49998",
    DB_PATH: path.join(dir, "monitor.db"),
    CHAIN_ID: "137",
    TOKEN_CONTRACT,
    TOKEN_DECIMALS: "18",
    JPYC_BASE_UNIT_SCALE: "1000000",
    RPC_URLS: "http://127.0.0.1:8545",
    REQUIRED_CONFIRMATIONS: "1",
    SERVICE_INGEST_ID: "chain-monitor",
    SERVICE_INGEST_SECRET: "x".repeat(48),
  };
  return withEnv(env, async () => {
    const entry = pathToFileURL(path.join(ROOT, "src/chain-monitor.mjs")).href;
    return import(`${entry}?exactness=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  });
}

function createInvoiceTable(db) {
  db.exec(`
    CREATE TABLE invoices (
      id TEXT PRIMARY KEY,
      amount_jpyc REAL NOT NULL,
      amount_jpyc_base TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      status TEXT NOT NULL,
      chain_id TEXT NOT NULL,
      token_contract TEXT NOT NULL,
      monitor_until TEXT,
      integrity_hold INTEGER NOT NULL DEFAULT 0,
      last_reconciled_block INTEGER
    )
  `);
}

test("cancelled and reissued-old receive addresses remain chain-monitor candidates", async (t) => {
  const mod = await loadMonitorModule();
  t.after(() => mod.db.close());
  createInvoiceTable(mod.db);
  const insert = mod.db.prepare(
    `INSERT INTO invoices
     (id, amount_jpyc, amount_jpyc_base, recipient_address, status, chain_id, token_contract)
     VALUES (?, ?, ?, ?, ?, '137', ?)`
  );
  insert.run("invoice-cancelled-old", 1500, "1500000000", OLD_ADDRESS, "cancelled", TOKEN_CONTRACT);
  insert.run("invoice-reissued-new", 1500, "1500000000", NEW_ADDRESS, "issued", TOKEN_CONTRACT);

  const candidates = mod.getCandidateInvoices();
  assert.deepEqual(
    new Set(candidates.map((invoice) => invoice.id)),
    new Set(["invoice-cancelled-old", "invoice-reissued-new"])
  );
  const selected = mod.selectInvoiceForLog(candidates, OLD_ADDRESS.toLowerCase(), "1500000000");
  assert.equal(selected.invoice?.id, "invoice-cancelled-old");
  assert.equal(selected.reason, "exact_amount");
});

test("non-exact 18-to-6 conversion keeps the matched invoice and raw atomic evidence", async (t) => {
  const mod = await loadMonitorModule();
  t.after(() => mod.db.close());
  const expectedBase = "1500000000";
  const rawAtomic = `${BigInt(expectedBase) * 10n ** 12n + 1n}`;
  const conversion = mod.toAppBaseUnitsFromTokenValue(rawAtomic);
  assert.equal(conversion.error, "non_exact_decimal_conversion");
  assert.equal(conversion.value, expectedBase);

  const selected = mod.selectInvoiceForLog([
    {
      id: "invoice-cancelled-old",
      amount_jpyc: 1500,
      amount_jpyc_base: expectedBase,
      recipient_address: OLD_ADDRESS,
      status: "cancelled",
    },
  ], OLD_ADDRESS.toLowerCase(), conversion.value);
  assert.equal(selected.invoice?.id, "invoice-cancelled-old");

  const payload = mod.buildPaymentIngestPayload({
    invoiceId: selected.invoice.id,
    amountBase: conversion.value,
    amountAtomic: rawAtomic,
    toAddress: OLD_ADDRESS,
    fromAddress: "0x6000000000000000000000000000000000000001",
    confirmations: 3,
    txHash: `0x${"a".repeat(64)}`,
    logIndex: 7,
    blockNumber: 123,
    blockHash: `0x${"b".repeat(64)}`,
    blockTimestamp: "2026-07-25T00:00:00.000Z",
    detectedAt: "2026-07-25T00:00:05.000Z",
    canonicalStatus: "canonical",
    amountConversionExact: false,
    amountConversionError: conversion.error,
  });

  assert.equal(payload.invoice_id, "invoice-cancelled-old");
  assert.equal(payload.amount_jpyc_base, expectedBase);
  assert.equal(payload.amount_atomic, rawAtomic);
  assert.equal(payload.amount_conversion_exact, false);
  assert.equal(payload.amount_conversion_error, "non_exact_decimal_conversion");
  assert.equal(payload.canonical_status, "canonical");
  assert.equal(payload.source, "chain_monitor");
});

test("chain monitor emits canonical only for an explicit block-hash match", async (t) => {
  const mod = await loadMonitorModule();
  t.after(() => mod.db.close());
  const hash = `0x${"c".repeat(64)}`;

  assert.equal(mod.canonicalStatusForLog({ blockHash: hash.toUpperCase() }, { hash }), "canonical");
  assert.equal(
    mod.canonicalStatusForLog({ blockHash: hash }, { hash: `0x${"d".repeat(64)}` }),
    "unknown"
  );
  assert.equal(mod.canonicalStatusForLog({}, { hash }), "unknown");

  const unknownPayload = mod.buildPaymentIngestPayload({
    invoiceId: "invoice-unknown-canonicality",
    amountBase: "1",
    amountAtomic: "1000000000000",
    toAddress: OLD_ADDRESS,
    fromAddress: NEW_ADDRESS,
    confirmations: 1,
    txHash: `0x${"e".repeat(64)}`,
    logIndex: 0,
    blockNumber: 1,
    blockHash: "",
    blockTimestamp: null,
    detectedAt: "2026-07-25T00:00:00.000Z",
    canonicalStatus: "unverified",
    amountConversionExact: true,
  });
  assert.equal(unknownPayload.canonical_status, "unknown");
  assert.equal(unknownPayload.amount_conversion_exact, true);
  assert.equal(unknownPayload.amount_conversion_error, null);
});
