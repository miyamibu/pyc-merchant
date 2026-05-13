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

The narrative specification lives in:

- [`docs/35-settlement-export-contract-v1.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/35-settlement-export-contract-v1.md)
- [`docs/contracts/settlement-export-v1.schema.json`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/contracts/settlement-export-v1.schema.json)
