import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDailyAccountingSummary,
  deduplicateLegacyRefundRows,
  deduplicateLegacySettlementRows,
  LEGACY_INVOICE_ATTRIBUTION_VALUES,
  LEGACY_REFUND_ATTRIBUTION_VALUES,
  normalizeLegacySettlementRows,
} from "../src/settlement-export.mjs";

function accountingRow(overrides = {}) {
  return {
    invoice_id: "invoice-1",
    accounting_status: "onchain_cash_confirmed",
    onchain_cash_amount_jpyc_base: "100",
    provider_receivable_amount_jpyc_base: "0",
    exception_amount_jpyc_base: "0",
    refund_amount_jpyc_base: "0",
    void_amount_jpyc_base: "0",
    ...overrides,
  };
}

test("normalizes joined legacy detail while attributing each invoice exactly once", () => {
  const rows = [
    accountingRow({ refund_request_id: "refund-b", refund_tx_hash: "0xbbb" }),
    accountingRow({ refund_request_id: "refund-a", refund_tx_hash: "0xaaa" }),
    accountingRow({
      invoice_id: "invoice-2",
      refund_request_id: null,
      refund_tx_hash: null,
      onchain_cash_amount_jpyc_base: "250",
    }),
  ];
  const originalRows = structuredClone(rows);

  const normalized = normalizeLegacySettlementRows(rows);

  assert.deepEqual(LEGACY_INVOICE_ATTRIBUTION_VALUES, [
    "invoice_primary",
    "invoice_detail_only",
  ]);
  assert.deepEqual(LEGACY_REFUND_ATTRIBUTION_VALUES, [
    "refund_primary",
    "refund_detail_only",
    "none",
  ]);
  assert.equal(normalized.joined_row_count, 3);
  assert.equal(normalized.invoice_count, 2);
  assert.equal(normalized.refund_count, 2);
  assert.equal(normalized.duplicate_row_count, 1);
  assert.equal(normalized.duplicate_refund_row_count, 0);
  assert.equal(normalized.detail_rows.length, 3);
  assert.equal(
    normalized.detail_rows.find((row) => row.refund_request_id === "refund-a")
      .legacy_invoice_attribution,
    "invoice_primary"
  );
  assert.equal(
    normalized.detail_rows.find((row) => row.refund_request_id === "refund-b")
      .legacy_invoice_attribution,
    "invoice_detail_only"
  );
  assert.deepEqual(normalized.invoice_rows.map((row) => row.invoice_id).sort(), [
    "invoice-1",
    "invoice-2",
  ]);
  assert.deepEqual(
    normalized.invoice_rows.find((row) => row.invoice_id === "invoice-1").legacy_refund_references
      .map((row) => row.refund_request_id),
    ["refund-a", "refund-b"]
  );
  assert.equal(
    normalized.invoice_rows.find((row) => row.invoice_id === "invoice-1").legacy_refund_reference_count,
    2
  );
  assert.deepEqual(rows, originalRows, "normalization must not mutate query rows");

  const summary = buildDailyAccountingSummary(normalized.invoice_rows);
  assert.equal(summary.onchain_cash_confirmed.count, 2);
  assert.equal(summary.onchain_cash_confirmed.amount_jpyc_base, "350");
});

test("primary attribution is deterministic when joined row order changes", () => {
  const rows = [
    accountingRow({ refund_request_id: "refund-b", refund_tx_hash: "0xbbb" }),
    accountingRow({ refund_request_id: "refund-a", refund_tx_hash: "0xaaa" }),
  ];

  const forward = normalizeLegacySettlementRows(rows);
  const reverse = normalizeLegacySettlementRows([...rows].reverse());

  assert.equal(forward.invoice_rows[0].refund_request_id, "refund-a");
  assert.equal(reverse.invoice_rows[0].refund_request_id, "refund-a");

  const rowsWithoutSelectedIds = [
    accountingRow({ refund_request_id: null, reason_code: "OTHER", audit_ref: "audit-b" }),
    accountingRow({ refund_request_id: null, reason_code: "AMOUNT_MISMATCH", audit_ref: "audit-a" }),
  ];
  const fallbackForward = normalizeLegacySettlementRows(rowsWithoutSelectedIds);
  const fallbackReverse = normalizeLegacySettlementRows([...rowsWithoutSelectedIds].reverse());
  assert.equal(fallbackForward.invoice_rows[0].reason_code, "AMOUNT_MISMATCH");
  assert.equal(fallbackReverse.invoice_rows[0].reason_code, "AMOUNT_MISMATCH");
});

test("rows without invoice identity are preserved instead of being collapsed together", () => {
  const rows = [
    accountingRow({ invoice_id: null, refund_request_id: "refund-a" }),
    accountingRow({ invoice_id: "", refund_request_id: "refund-b" }),
  ];

  const normalized = normalizeLegacySettlementRows(rows);
  assert.equal(normalized.invoice_rows.length, 2);
  assert.equal(normalized.duplicate_row_count, 0);
  assert.ok(
    normalized.detail_rows.every(
      (row) => row.legacy_invoice_attribution === "invoice_primary"
    )
  );
});

test("deduplicateLegacySettlementRows returns only invoice-primary rows", () => {
  const rows = [
    accountingRow({ refund_request_id: "refund-b" }),
    accountingRow({ refund_request_id: "refund-a" }),
    accountingRow({ invoice_id: "invoice-2", refund_request_id: null }),
  ];

  const invoiceRows = deduplicateLegacySettlementRows(rows);
  assert.equal(invoiceRows.length, 2);
  assert.ok(
    invoiceRows.every((row) => row.legacy_invoice_attribution === "invoice_primary")
  );
});

test("refund aggregation counts each refund request once across review join duplicates", () => {
  const rows = [
    accountingRow({
      review_case_id: "review-b",
      refund_request_id: "refund-a",
      refund_status: "requested",
      refund_amount_jpyc_base: "25",
    }),
    accountingRow({
      review_case_id: "review-a",
      refund_request_id: "refund-a",
      refund_status: "requested",
      refund_amount_jpyc_base: "25",
    }),
    accountingRow({
      review_case_id: "review-a",
      refund_request_id: "refund-b",
      refund_status: "succeeded",
      refund_amount_jpyc_base: "40",
    }),
    accountingRow({
      invoice_id: "invoice-2",
      review_case_id: "review-only",
      refund_request_id: null,
      refund_status: null,
    }),
  ];

  const normalized = normalizeLegacySettlementRows(rows);
  assert.equal(normalized.joined_row_count, 4);
  assert.equal(normalized.invoice_count, 2);
  assert.equal(normalized.refund_count, 2);
  assert.equal(normalized.duplicate_refund_row_count, 1);
  assert.deepEqual(
    normalized.refund_rows.map((row) => row.refund_request_id),
    ["refund-a", "refund-b"]
  );
  assert.equal(
    normalized.refund_rows.filter((row) => row.refund_status === "requested").length,
    1
  );
  assert.equal(
    normalized.refund_rows.filter((row) => row.refund_status === "succeeded").length,
    1
  );
  assert.equal(
    normalized.detail_rows.find(
      (row) => row.refund_request_id === "refund-a" && row.review_case_id === "review-a"
    ).legacy_refund_attribution,
    "refund_primary"
  );
  assert.equal(
    normalized.detail_rows.find(
      (row) => row.refund_request_id === "refund-a" && row.review_case_id === "review-b"
    ).legacy_refund_attribution,
    "refund_detail_only"
  );
  assert.deepEqual(normalized.invoice_rows[0].legacy_refund_references, [
    {
      refund_request_id: "refund-a",
      refund_case_id: null,
      review_case_id: "review-a",
      refund_status: "requested",
      refund_amount_jpyc_base: "25",
      refund_tx_hash: null,
      refund_verified_at: null,
    },
    {
      refund_request_id: "refund-b",
      refund_case_id: null,
      review_case_id: "review-a",
      refund_status: "succeeded",
      refund_amount_jpyc_base: "40",
      refund_tx_hash: null,
      refund_verified_at: null,
    },
  ]);

  assert.deepEqual(
    deduplicateLegacyRefundRows([...rows].reverse()).map((row) => row.refund_request_id),
    ["refund-a", "refund-b"]
  );
  assert.equal(
    deduplicateLegacyRefundRows([...rows].reverse())
      .find((row) => row.refund_request_id === "refund-a").review_case_id,
    "review-a",
    "refund primary selection must remain deterministic when joined row order changes"
  );
});
