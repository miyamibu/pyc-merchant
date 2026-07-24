# 35. Settlement Export Contract v1

## Goal
Define a stable accounting interface and frozen accounting snapshot for daily close, accounting export, and future provider adapters.

## Context
- This repository remains a non-custodial Merchant Ops / Settlement Layer.
- `Settlement Export Contract v1` is derived from `invoice + payment evidence + reconciliation`.
- It is not the primary operational ledger.
- Operational source of truth remains `invoices`, payment evidence, provider/reconciliation sidecar tables, and audit logs.

## Constraints
- Provider statuses must be canonicalized before export.
- Provider raw status names must not leak into canonical `accounting_status`.
- Provider raw payload must not be exported.
- Personal/private artifacts must be `export_excluded`.
- `onchain_cash_amount_jpyc_base` may be positive only when on-chain verification is satisfied.
- `provider_receivable_amount_jpyc_base` may be positive when provider accepted/captured but on-chain cash is not confirmed.
- Provider accepted/captured is not `paid`.
- Settlement export rows are frozen accounting snapshots derived from operational data, not inputs to future state transitions.

## Canonical enums
### `accounting_status`
- `onchain_cash_confirmed`
- `provider_receivable`
- `provider_settlement_pending`
- `provider_settled_unallocated`
- `exception_pending`
- `voided`
- `cancelled`
- `refunded_onchain`
- `provider_refunded`

### `cash_recognition_status`
- `none`
- `onchain_confirmed`
- `batch_confirmed`
- `disputed`

### `receivable_status`
- `none`
- `provider_accepted`
- `provider_captured`
- `settlement_reported`
- `settlement_overdue`
- `disputed`

## Snapshot rules
- The machine-readable v1 row requires 40 fields. Optional business events are represented by nullable values or empty arrays, not by removing the field.
- Every row preserves `export_reference`, settlement/export identities, invoice/checkout identities, store/terminal/operator identities, chain/token/recipient identities, payment attempt and primary transfer evidence, review/refund evidence, audit refs, external sync refs, and a source-ledger snapshot hash.
- `chain_id` is limited to Ethereum `1`, Avalanche C-Chain `43114`, and Polygon `137`, using the official funds-transfer JPYC contract `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`.
- New export creation uses v2. Legacy v1 snapshot bytes remain immutable and are never synthesized again from the current ledger.
- `GET` endpoints must not create settlement exports, export runs, export rows, audit entries, files, or other accounting side effects.
- `POST /api/v1/settlements/daily:close` creates the daily close settlement export snapshot as part of the close operation.
- `POST /api/v1/settlement-exports` creates an on-demand immutable settlement export snapshot and requires `Idempotency-Key`; same key and same payload must return the same response, while same key and different payload must conflict.
- `GET /api/v1/settlement-exports/:id` returns existing snapshot metadata and rows scoped to the caller's store and must not recalculate or mutate accounting state.
- `GET /api/v1/settlement-exports/:id/download` returns the existing snapshot as JSON or UTF-8 BOM CSV and must not recalculate or mutate accounting state.
- Formal export snapshots include content hash metadata so downloaded JSON/CSV payloads can be reconciled to the immutable export record.
- Legacy daily/monthly operational exports keep joined review/refund detail rows for traceability, expose deterministic `invoice_rows` (one primary row per invoice) and `refund_rows` (one `refund_primary` row per `refund_request_id`), calculate invoice totals/CSV from invoice-primary rows, and calculate refund counters from refund-primary rows. The one-row-per-invoice CSV carries every linked refund in a deterministic JSON aggregate column defined by the API specification, so avoiding duplicate invoice amounts does not discard secondary refunds. This behavior does not rewrite stored v1 snapshot bytes.
- `paid` remains chain-verified only.
- Wallet-direct paid invoices export as `onchain_cash_confirmed`.
- Provider accepted/captured without chain-paid evidence exports as `provider_receivable`.
- Provider settlement reports with clean invoice allocation but without chain-paid evidence export as `provider_settlement_pending`.
- `provider_settled_unallocated` is reserved for provider batch settlement evidence that cannot be cleanly allocated back to the invoice snapshot.
- `cash_recognition_status=batch_confirmed` may be used when provider batch settlement evidence exists without direct per-invoice on-chain cash finality.
- Review-required invoices export as `exception_pending`.
- Provider void exports as `voided` and must not be rewritten into staff `cancelled` semantics.
- Provider refund and on-chain refund remain separate accounting outcomes.

## Privacy rules
- Provider raw payload is never exported.
- Payment ledger and settlement export must not store or expose my number, JPKI certificate data, name, address, birthdate, payer identity, or payer hash.
- If private artifacts are required in a future phase, they must be isolated outside the payment ledger and excluded from settlement export.

## Done when
- A settlement export row can explain accounting meaning without leaking vendor payload semantics.
- `provider accepted/captured != paid` is preserved in code and tests.
- Daily close can separate on-chain confirmed cash from provider receivable.
