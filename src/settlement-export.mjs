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
