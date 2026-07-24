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
    "docs/35-settlement-export-contract-v2.md",
    "docs/contracts/settlement-export-v2.md",
    "docs/contracts/settlement-export-v2.schema.json",
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
  assert.equal(schema.required.length, 40, "Settlement Export Contract v1 must retain exactly 40 required fields");
  for (const field of [
    "export_reference", "settlement_id", "settlement_export_run_id", "settlement_export_row_id",
    "invoice_no", "checkout_session_id", "store_id", "terminal_id", "operator_id",
    "chain_id", "network", "token_contract", "recipient_address", "payment_attempt_ids",
    "primary_tx_hash", "primary_tx_log_index", "review_case_id", "review_reason_type",
    "refund_request_id", "refund_tx_hash", "audit_log_refs", "external_sync_refs",
    "source_ledger_snapshot_hash",
  ]) {
    assert.ok(schema.required.includes(field), `${field} must be required in v1`);
    assert.ok(schema.properties[field], `${field} must be defined in v1`);
  }
  assert.deepEqual(schema.properties.chain_id.enum, ["1", "43114", "137"]);
  assert.match(schema.properties.token_contract.pattern, /\[Ee\]7/);
  assert.equal(schema.allOf.length, 5, "v1 must fail closed on five conditional traceability rules");
  for (const v2OnlyField of [
    "refund_reference_status",
    "refund_reference_count",
    "refund_requested_amount_jpyc_base",
    "refund_reserved_amount_jpyc_base",
    "refund_succeeded_amount_jpyc_base",
    "refund_references",
  ]) {
    assert.equal(schema.required.includes(v2OnlyField), false, `${v2OnlyField} must not change Settlement Export Contract v1`);
    assert.equal(schema.properties[v2OnlyField], undefined, `${v2OnlyField} belongs to Settlement Export Contract v2`);
  }
});

test("Settlement Export Contract v2 pins invoice-scoped refund manifest and primary-row attribution", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, "docs/contracts/settlement-export-v2.schema.json"), "utf8")
  );
  assert.equal(schema.properties.contract_version.const, "settlement_export_v2");
  assert.equal(schema.properties.export_version.const, "v2");
  assert.ok(schema.required.includes("refund_manifest"));
  assert.ok(schema.required.includes("refund_totals"));
  assert.deepEqual(schema.$defs.row.properties.refund_attribution.enum, [
    "none",
    "invoice_primary",
    "invoice_manifest_only",
  ]);
  assert.equal(schema.$defs.refundManifestEntry.allOf[1].properties.attribution.const, "invoice_primary_row");
  assert.equal(
    schema.$defs.metadata.properties.hash_scope.properties.version.const,
    "settlement_export_v2_canonical_payload_without_content_hashes"
  );
  const v1TraceFields = JSON.parse(
    fs.readFileSync(path.join(ROOT, "docs/contracts/settlement-export-v1.schema.json"), "utf8")
  ).required.filter((field) => ![
    "export_version", "business_date", "rail_type", "provider_code", "invoice_status",
    "accounting_status", "cash_recognition_status", "receivable_status",
    "onchain_cash_amount_jpyc_base", "provider_receivable_amount_jpyc_base",
    "exception_amount_jpyc_base", "refund_amount_jpyc_base", "void_amount_jpyc_base",
    "evidence_hash", "payload_schema_version", "export_excluded_private_data",
  ].includes(field));
  for (const field of v1TraceFields) {
    assert.ok(schema.$defs.row.required.includes(field), `${field} must be additively required in v2 rows`);
    assert.ok(schema.$defs.row.properties[field], `${field} must be defined in v2 rows`);
  }
  assert.ok(schema.$defs.row.required.includes("accounting_event_refs"));
  assert.deepEqual(schema.$defs.row.properties.accounting_event_refs, {
    type: "array",
    items: { type: "string", minLength: 1 },
  });
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
  const v2ContractDoc = fs.readFileSync(path.join(ROOT, "docs/35-settlement-export-contract-v2.md"), "utf8");
  assert.match(contractDoc, /Provider accepted\/captured is not `paid`\./);
  assert.match(contractDoc, /derived from `invoice \+ payment evidence \+ reconciliation`/);
  assert.match(contractDoc, /Provider raw payload must not be exported\./);
  assert.doesNotMatch(contractDoc, /refund_manifest|refund_references/);
  assert.match(v2ContractDoc, /Every refund case linked to an invoice is frozen once in the top-level `refund_manifest`/);
  assert.match(v2ContractDoc, /`failed` and `verification_failed` remain reserved/);
  assert.match(v2ContractDoc, /legacy_export_missing/);
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
  assert.match(serverSource, /SETTLEMENT_EXPORT_V2_CANONICAL_HASH_SCOPE/);
  assert.match(serverSource, /refund_references_json/);
  assert.match(serverSource, /accounting_event_refs_json/);
  assert.match(serverSource, /accounting_event_journal/);
  assert.match(serverSource, /ACTIVE_INVOICES_BLOCK_CLOSE/);
  assert.match(serverSource, /settlement_id = \? AND store_id = \?/);
  assert.match(serverSource, /buildSettlementExportV1SnapshotCsv\(rows, \{ bom: true \}\)/);
  assert.match(serverSource, /buildSettlementExportV2SnapshotCsv\(rows, \{ bom: true \}\)/);
  assert.match(serverSource, /resolveSettlementExportContractVersion/);
  assert.match(serverSource, /legacy_export_missing/);
  assert.match(serverSource, /addColumnIfMissing\("settlement_export_rows", "payload_json"/);
  assert.match(serverSource, /JSON\.stringify\(row\)/);

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
