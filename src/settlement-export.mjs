export const ACCOUNTING_STATUS_VALUES = [
  "onchain_cash_confirmed",
  "provider_receivable",
  "provider_settlement_pending",
  "provider_settled_unallocated",
  "exception_pending",
  "voided",
  "cancelled",
  "refunded_onchain",
  "provider_refunded",
];

export const CASH_RECOGNITION_STATUS_VALUES = [
  "none",
  "onchain_confirmed",
  "batch_confirmed",
  "disputed",
];

export const RECEIVABLE_STATUS_VALUES = [
  "none",
  "provider_accepted",
  "provider_captured",
  "settlement_reported",
  "settlement_overdue",
  "disputed",
];

const SUMMARY_KEYS = [
  "onchain_cash_confirmed",
  "provider_receivable",
  "provider_settlement_pending",
  "provider_settled_unallocated",
  "exception_pending",
  "voided",
  "cancelled",
  "refunded_onchain",
  "provider_refunded",
];

export const LEGACY_INVOICE_ATTRIBUTION_VALUES = Object.freeze([
  "invoice_primary",
  "invoice_detail_only",
]);

export const LEGACY_REFUND_ATTRIBUTION_VALUES = Object.freeze([
  "refund_primary",
  "refund_detail_only",
  "none",
]);

function compareLegacySettlementDetail(left, right) {
  const preferredFields = [
    "refund_request_id",
    "review_case_id",
    "refund_tx_hash",
    "refund_verified_at",
    "refund_status",
    "reason_code",
    "review_status",
    "block_timestamp",
    "detected_at",
    "audit_ref",
    "created_at",
    "updated_at",
  ];
  const remainingFields = [...new Set([
    ...Object.keys(left.row || {}),
    ...Object.keys(right.row || {}),
  ])]
    .filter((field) => !preferredFields.includes(field))
    .sort();
  for (const field of [...preferredFields, ...remainingFields]) {
    const leftValue = String(left.row?.[field] ?? "");
    const rightValue = String(right.row?.[field] ?? "");
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return left.index - right.index;
}

export function normalizeLegacySettlementRows(rows = []) {
  const indexedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({ row, index }));
  const groups = new Map();
  for (const entry of indexedRows) {
    const invoiceId = String(entry.row?.invoice_id || "").trim();
    const groupKey = invoiceId ? `invoice:${invoiceId}` : `unscoped-row:${entry.index}`;
    const group = groups.get(groupKey) || [];
    group.push(entry);
    groups.set(groupKey, group);
  }

  const primaryIndexes = new Set();
  for (const group of groups.values()) {
    const primary = [...group].sort(compareLegacySettlementDetail)[0];
    if (primary) primaryIndexes.add(primary.index);
  }

  const refundGroups = new Map();
  for (const entry of indexedRows) {
    const refundRequestId = String(entry.row?.refund_request_id || "").trim();
    if (!refundRequestId) continue;
    const groupKey = `refund:${refundRequestId}`;
    const group = refundGroups.get(groupKey) || [];
    group.push(entry);
    refundGroups.set(groupKey, group);
  }
  const refundPrimaryIndexes = new Set();
  for (const group of refundGroups.values()) {
    const primary = [...group].sort(compareLegacySettlementDetail)[0];
    if (primary) refundPrimaryIndexes.add(primary.index);
  }

  const detailRows = indexedRows.map(({ row, index }) => ({
    ...(row || {}),
    legacy_invoice_attribution: primaryIndexes.has(index) ? "invoice_primary" : "invoice_detail_only",
    legacy_refund_attribution: !String(row?.refund_request_id || "").trim()
      ? "none"
      : (refundPrimaryIndexes.has(index) ? "refund_primary" : "refund_detail_only"),
  }));
  const primaryInvoiceRows = detailRows.filter(
    (row) => row.legacy_invoice_attribution === "invoice_primary"
  );
  const refundRows = detailRows
    .filter((row) => row.legacy_refund_attribution === "refund_primary")
    .sort((left, right) => {
      const leftKey = `${String(left.invoice_id || "")}\u0000${String(left.refund_request_id || "")}`;
      const rightKey = `${String(right.invoice_id || "")}\u0000${String(right.refund_request_id || "")}`;
      return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
    });
  const refundReferencesByInvoice = new Map();
  for (const row of refundRows) {
    const invoiceId = String(row.invoice_id || "").trim();
    if (!invoiceId) continue;
    const references = refundReferencesByInvoice.get(invoiceId) || [];
    references.push({
      refund_request_id: row.refund_request_id,
      refund_case_id: row.refund_case_id || null,
      review_case_id: row.refund_review_case_id || row.review_case_id || null,
      refund_status: row.refund_status || null,
      refund_amount_jpyc_base: row.refund_amount_jpyc_base ?? null,
      refund_tx_hash: row.refund_tx_hash || null,
      refund_verified_at: row.refund_verified_at || null,
    });
    refundReferencesByInvoice.set(invoiceId, references);
  }
  const invoiceRows = primaryInvoiceRows.map((row) => {
    const references = refundReferencesByInvoice.get(String(row.invoice_id || "").trim()) || [];
    return {
      ...row,
      legacy_refund_reference_count: references.length,
      legacy_refund_references: references,
    };
  });
  return {
    detail_rows: detailRows,
    invoice_rows: invoiceRows,
    refund_rows: refundRows,
    invoice_count: invoiceRows.length,
    refund_count: refundRows.length,
    joined_row_count: detailRows.length,
    duplicate_row_count: detailRows.length - invoiceRows.length,
    duplicate_refund_row_count: detailRows.filter(
      (row) => row.legacy_refund_attribution === "refund_detail_only"
    ).length,
  };
}

export function deduplicateLegacySettlementRows(rows = []) {
  return normalizeLegacySettlementRows(rows).invoice_rows;
}

export function deduplicateLegacyRefundRows(rows = []) {
  return normalizeLegacySettlementRows(rows).refund_rows;
}

export function buildDailyAccountingSummary(rows = []) {
  const summary = Object.fromEntries(
    SUMMARY_KEYS.map((key) => [key, { count: 0, amount_jpyc_base: "0" }])
  );
  for (const row of rows) {
    const key = String(row.accounting_status || "");
    if (!summary[key]) continue;
    summary[key].count += 1;
    const current = BigInt(summary[key].amount_jpyc_base || "0");
    const next = BigInt(
      String(
        row.onchain_cash_amount_jpyc_base
        || row.provider_receivable_amount_jpyc_base
        || row.exception_amount_jpyc_base
        || row.refund_amount_jpyc_base
        || row.void_amount_jpyc_base
        || 0
      )
    );
    summary[key].amount_jpyc_base = (current + next).toString();
  }
  return summary;
}
