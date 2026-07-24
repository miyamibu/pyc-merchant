# Settlement Export Contract v2

Canonical contract summary for `settlement_export_v2`.

- v2 is additive and does not redefine or mutate Settlement Export Contract v1.
- New snapshots store `contract_version: settlement_export_v2` and `export_version: v2`.
- `refund_manifest` is invoice-scoped and freezes every refund case once.
- `refund_totals` is calculated from the invoice manifest, never by summing duplicated payment-session references.
- Exactly one deterministic row can use `refund_attribution: invoice_primary`; sibling rows use `invoice_manifest_only`.
- Invalid refund base-unit values fail closed.
- Rows use a stable persisted order for hashing and download.
- Every new row freezes the v1 40-field lineage set additively, including chain/token/recipient, payment attempt, review/refund, audit, external sync, and source-ledger hash references.
- `accounting_event_refs` freezes the append-only payment/refund accounting journal rows recognized on the export business date; the references preserve the occurrence-date adjustment trail for invoices issued on an earlier date.
- Refund references include the independent `refund_case_id`, optional related `review_case_id`, and optional `funding_lineage_id` so refund ownership and receive-address-to-treasury sweep evidence remain traceable.
- The frozen row payload is stored at snapshot creation; downloads do not rebuild historical lineage from the current operational ledger.
- The JPYC rail is limited to chain IDs `1`, `43114`, and `137` with funds-transfer JPYC contract `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`.
- Daily-close exports bind to `settlement_id`; missing legacy bindings are reported as `legacy_export_missing` without guessing.
- Vendor adapters may transform v2 but must preserve invoice, payment, refund, review, settlement, audit, and external-reference traceability.

The machine-readable payload contract is `settlement-export-v2.schema.json`.
