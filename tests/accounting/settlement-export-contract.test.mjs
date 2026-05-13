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
  for (const field of [
    "export_reference",
    "settlement_id",
    "settlement_export_run_id",
    "settlement_export_row_id",
    "business_date",
    "invoice_id",
    "invoice_no",
    "checkout_session_id",
    "store_id",
    "terminal_id",
    "operator_id",
    "payment_attempt_ids",
    "primary_tx_hash",
    "primary_tx_log_index",
    "review_case_id",
    "review_reason_type",
    "refund_request_id",
    "refund_tx_hash",
    "audit_log_refs",
    "external_sync_refs",
    "source_ledger_snapshot_hash",
  ]) {
    assert.ok(schema.required.includes(field), `${field} must be required for traceability`);
    assert.ok(schema.properties[field], `${field} must have schema`);
  }
});

test("settlement export traceability invariants are documented", () => {
  const contractDoc = fs.readFileSync(path.join(ROOT, "docs/contracts/settlement-export-v1.md"), "utf8");
  assert.match(contractDoc, /Every exported row must include the traceability properties/);
  assert.match(contractDoc, /A paid row must carry payment evidence/);
  assert.match(contractDoc, /A review row must carry `review_case_id` and `review_reason_type`/);
  assert.match(contractDoc, /A refund row must carry `refund_request_id` and `refund_tx_hash`/);
  assert.match(contractDoc, /Vendor adapters are downstream transforms and must preserve all required trace fields/);
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
