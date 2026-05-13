# Settlement Export Contract v1

Canonical contract summary for `Settlement Export Contract v1`.

- This contract is an accounting interface and frozen accounting snapshot.
- It is derived from invoice, payment evidence, and reconciliation data.
- It is not the primary operational ledger.
- Provider raw statuses must be canonicalized before export.
- Provider raw payload must not be exported.
- Personal/private artifacts must remain export-excluded.
- Provider `accepted` / `captured` evidence is receivable evidence, not `paid`.
- `provider_settlement_pending` is for cleanly matched provider settlement evidence that still lacks direct on-chain cash finality.
- `provider_settled_unallocated` is for provider batch settlement evidence that cannot be cleanly allocated in the export snapshot.
- Provider `voided` evidence remains distinct from staff `cancelled`.
- Every exported row must include the traceability properties defined by the schema, even when a business event has no review/refund/provider reference and the value is `null` or an empty array.
- Required trace fields include `export_reference`, settlement/export row identity, invoice identity, checkout session/store/terminal/operator identity, payment attempt and primary transfer evidence, review/refund evidence fields, audit refs, external sync refs, and `source_ledger_snapshot_hash`.
- A paid row must carry payment evidence through `primary_tx_hash` or `payment_attempt_ids`.
- A review row must carry `review_case_id` and `review_reason_type`.
- A refund row must carry `refund_request_id` and `refund_tx_hash` when the refund has on-chain execution evidence.
- Business-impacting rows must carry at least one `audit_log_refs` entry.
- `provider_receivable`, `provider_settlement_pending`, and `provider_settled_unallocated` rows must preserve provider/external sync trace references.
- Daily JSON export, monthly JSON export, CSV export, and settlement evidence packs must serialize this same v1 row shape. CSV array/object values are serialized with `JSON.stringify` before CSV escaping.
- Vendor adapters are downstream transforms and must preserve all required trace fields.

The narrative specification lives in:

- [`docs/35-settlement-export-contract-v1.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/35-settlement-export-contract-v1.md)
- [`docs/contracts/settlement-export-v1.schema.json`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/contracts/settlement-export-v1.schema.json)
