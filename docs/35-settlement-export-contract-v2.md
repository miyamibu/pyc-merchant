# 35. Settlement Export Contract v2

## Goal

Extend the immutable settlement export with complete refund lineage and reproducible content hashes without changing Settlement Export Contract v1 bytes or meanings.

## Context

- New settlement export snapshots use `contract_version: settlement_export_v2` and `export_version: v2`.
- Existing snapshots without `contract_version`, or with the v1 markers, remain Settlement Export Contract v1 and use the original v1 serializers.
- The server-side ledger remains the source of truth. The export is an immutable accounting snapshot, not a vendor adapter.

## Constraints

- v1 CSV headers, v1 row shape, v1 JSON download shape, and v1 hash behavior are frozen at their original contract.
- v1 rows must never receive v2 fields through read-time synthesis.
- Every refund case linked to an invoice is frozen once in the top-level `refund_manifest`.
- Refund amounts and references may be attributed to exactly one deterministic primary row per invoice. Other payment-session rows must use `refund_attribution: invoice_manifest_only` with zero refund totals and an empty reference list.
- Wallet-direct is preferred as the primary row. Ties are resolved by stable provider code and payment-session identity.
- `refund_reserved_amount_jpyc_base` releases only `cancelled` and `rejected`. `failed` and `verification_failed` remain reserved.
- Invalid or non-safe-integer refund base-unit values stop refund creation and export creation with `REFUND_LEDGER_INTEGRITY_ERROR`.
- Rows are hashed and downloaded in the persisted deterministic order: invoice, payment session, rail, provider, then row ID.
- Each new v2 row additively freezes the v1 40-field traceability set. The v2 refund manifest and totals remain authoritative for invoice-scoped refund aggregation.
- Each new v2 row includes `accounting_event_refs`, the immutable IDs of payment-confirmed and refund-succeeded journal entries recognized on the export business date. A next-day refund therefore appears as an occurrence-date adjustment with a reference back to the original invoice.
- `settlement_export_rows.payload_json` stores the generated row payload. A later download reads this frozen payload rather than joining mutable operational tables.
- Chain identity is explicit: `chain_id`, network, official funds-transfer JPYC contract, and recipient address are part of every new row.
- JSON hashes cover the exact UTF-8 bytes of the canonical v2 payload and exclude self-referential content-hash fields and internal storage annotations.
- CSV hashes cover the exact UTF-8 BOM v2 CSV download bytes.
- A repeated daily close resolves only the export explicitly bound by `settlement_exports.settlement_id`. An older settlement without that binding returns `export_binding_status: legacy_export_missing` and must not guess a later export.
- An invoice stores its frozen local `business_date`; daily close blocks active invoices and does not reinterpret a late payment or refund as a new invoice. Accounting journal entries are attributed to their own occurrence business date.

## Refund manifest

Each manifest entry contains:

- `invoice_id`
- `primary_export_row_id`
- `primary_payment_session_id`
- `attribution: invoice_primary_row`
- every refund reference and its audit-log references
- requested, reserved, and succeeded base-unit totals

`refund_totals` sums manifest entries once per invoice. Row-level accounting summaries therefore do not multiply refunds when an invoice has multiple payment sessions.

## API behavior

- `POST /api/v1/settlement-exports` creates v2 and returns `contract_version`, `refund_manifest`, and `refund_totals`.
- `POST /api/v1/settlements/daily:close` creates a settlement-bound v2 artifact and returns the same contract markers.
- `GET /api/v1/settlement-exports/:id` resolves the stored contract version. v1 is returned without v2 row synthesis; v2 includes its frozen manifest.
- `GET /api/v1/settlement-exports/:id/download` uses the stored version serializer. The response header `X-Settlement-Export-Contract-Version` identifies the serializer without changing legacy v1 download bodies.

## Done when

- Existing v1 fixtures produce the original JSON and CSV shapes.
- New v2 snapshots include every refund exactly once in top-level totals.
- Multiple payment sessions do not duplicate recognized refund amounts.
- Repeated v2 downloads produce the stored content hash even when row timestamps tie.
- Corrupt refund amount data fails closed.
