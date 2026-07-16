# Settlement Export Contract v2

Canonical contract summary for `settlement_export_v2`.

- v2 is additive and does not redefine or mutate Settlement Export Contract v1.
- New snapshots store `contract_version: settlement_export_v2` and `export_version: v2`.
- `refund_manifest` is invoice-scoped and freezes every refund case once.
- `refund_totals` is calculated from the invoice manifest, never by summing duplicated payment-session references.
- Exactly one deterministic row can use `refund_attribution: invoice_primary`; sibling rows use `invoice_manifest_only`.
- Invalid refund base-unit values fail closed.
- Rows use a stable persisted order for hashing and download.
- Daily-close exports bind to `settlement_id`; missing legacy bindings are reported as `legacy_export_missing` without guessing.
- Vendor adapters may transform v2 but must preserve invoice, payment, refund, review, settlement, audit, and external-reference traceability.

The machine-readable payload contract is `settlement-export-v2.schema.json`.
