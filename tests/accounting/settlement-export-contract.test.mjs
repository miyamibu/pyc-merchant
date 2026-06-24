import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDailyAccountingSummary } from "../../src/settlement-export.mjs";

const ROOT = process.cwd();

test("settlement export contract docs and schema exist", () => {
  for (const relativePath of [
    "docs/35-settlement-export-contract-v1.md",
    "docs/36-payment-rail-abstraction.md",
    "docs/37-provider-rail-semantics.md",
    "docs/contracts/settlement-export-v1.md",
    "docs/contracts/settlement-export-v1.schema.json",
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), true, `${relativePath} should exist`);
  }
});

test("settlement export schema pins canonical enums and export privacy exclusion", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, "docs/contracts/settlement-export-v1.schema.json"), "utf8")
  );
  assert.deepEqual(schema.properties.accounting_status.enum, [
    "onchain_cash_confirmed",
    "provider_receivable",
    "provider_settlement_pending",
    "provider_settled_unallocated",
    "exception_pending",
    "voided",
    "cancelled",
    "refunded_onchain",
    "provider_refunded",
  ]);
  assert.deepEqual(schema.properties.cash_recognition_status.enum, [
    "none",
    "onchain_confirmed",
    "batch_confirmed",
    "disputed",
  ]);
  assert.deepEqual(schema.properties.receivable_status.enum, [
    "none",
    "provider_accepted",
    "provider_captured",
    "settlement_reported",
    "settlement_overdue",
    "disputed",
  ]);
  assert.deepEqual(schema.properties.export_excluded_private_data.enum, [1]);
});

test("buildDailyAccountingSummary aggregates cancelled rows alongside other accounting statuses", () => {
  const rows = [
    {
      accounting_status: "cancelled",
      onchain_cash_amount_jpyc_base: 0,
      provider_receivable_amount_jpyc_base: 0,
      exception_amount_jpyc_base: 0,
      refund_amount_jpyc_base: 0,
      void_amount_jpyc_base: 0,
    },
    {
      accounting_status: "cancelled",
      onchain_cash_amount_jpyc_base: 0,
      provider_receivable_amount_jpyc_base: 0,
      exception_amount_jpyc_base: 0,
      refund_amount_jpyc_base: 0,
      void_amount_jpyc_base: 0,
    },
    {
      accounting_status: "onchain_cash_confirmed",
      onchain_cash_amount_jpyc_base: 1000000,
      provider_receivable_amount_jpyc_base: 0,
      exception_amount_jpyc_base: 0,
      refund_amount_jpyc_base: 0,
      void_amount_jpyc_base: 0,
    },
    {
      accounting_status: "voided",
      onchain_cash_amount_jpyc_base: 0,
      provider_receivable_amount_jpyc_base: 0,
      exception_amount_jpyc_base: 0,
      refund_amount_jpyc_base: 0,
      void_amount_jpyc_base: 500000,
    },
  ];
  const summary = buildDailyAccountingSummary(rows);
  assert.ok(summary.cancelled, "summary.cancelled bucket must exist alongside voided/onchain_cash_confirmed");
  assert.equal(summary.cancelled.count, 2);
  assert.equal(summary.cancelled.amount_jpyc_base, "0");
  assert.equal(summary.onchain_cash_confirmed.count, 1);
  assert.equal(summary.onchain_cash_confirmed.amount_jpyc_base, "1000000");
  assert.equal(summary.voided.count, 1);
  assert.equal(summary.voided.amount_jpyc_base, "500000");
  assert.notEqual(
    summary.cancelled,
    summary.voided,
    "cancelled (staff) and voided (provider) must remain distinct buckets per contract"
  );
});

test("settlement export docs state provider accepted/captured is not paid", () => {
  const contractDoc = fs.readFileSync(path.join(ROOT, "docs/35-settlement-export-contract-v1.md"), "utf8");
  assert.match(contractDoc, /Provider accepted\/captured is not `paid`\./);
  assert.match(contractDoc, /derived from `invoice \+ payment evidence \+ reconciliation`/);
  assert.match(contractDoc, /Provider raw payload must not be exported\./);
});

test("settlement export HTTP contract separates read-only GET from snapshot POST", () => {
  const contractDoc = fs.readFileSync(path.join(ROOT, "docs/35-settlement-export-contract-v1.md"), "utf8");
  const serverSource = fs.readFileSync(path.join(ROOT, "src/server.mjs"), "utf8");
  assert.match(contractDoc, /GET` endpoints must not create settlement exports/);
  assert.match(contractDoc, /POST \/api\/v1\/settlements\/daily:close` creates the daily close settlement export snapshot/);
  assert.match(contractDoc, /POST \/api\/v1\/settlement-exports` creates an on-demand immutable settlement export snapshot/);
  assert.match(contractDoc, /GET \/api\/v1\/settlement-exports\/:id\/download` returns the existing snapshot as JSON or UTF-8 BOM CSV/);
  assert.match(contractDoc, /content hash metadata/);
  assert.match(serverSource, /app\.post\("\/api\/v1\/settlements\/daily:close"/);
  assert.match(serverSource, /app\.post\("\/api\/v1\/settlement-exports"/);
  assert.match(serverSource, /app\.get\("\/api\/v1\/settlement-exports\/:id\/download"/);
  assert.match(serverSource, /Idempotency-Key/);
  assert.match(serverSource, /content_hashes/);
  assert.match(serverSource, /buildSettlementExportSnapshotCsv\(rows, \{ bom: true \}\)/);

  const dailyGet = serverSource.match(/app\.get\("\/api\/v1\/settlements\/daily:export"[\s\S]*?\n\}\);/);
  const monthlyGet = serverSource.match(/app\.get\("\/api\/v1\/settlements\/monthly:export"[\s\S]*?\n\}\);/);
  const dailyClosePost = serverSource.match(/app\.post\("\/api\/v1\/settlements\/daily:close"[\s\S]*?app\.get\("\/api\/v1\/settlements\/daily:export"/);
  assert.ok(dailyGet, "daily export GET route should exist");
  assert.ok(monthlyGet, "monthly export GET route should exist");
  assert.ok(dailyClosePost, "daily close POST route should exist");
  assert.match(dailyClosePost[0], /createSettlementExportSnapshot/);
  assert.doesNotMatch(dailyGet[0], /createSettlementExportSnapshot|INSERT INTO settlement_exports/);
  assert.doesNotMatch(monthlyGet[0], /createSettlementExportSnapshot|INSERT INTO settlement_exports/);
});
