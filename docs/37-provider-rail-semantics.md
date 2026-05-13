# 37. Provider Rail Semantics

## Goal
Define provider-rail evidence semantics without collapsing provider UX events into accounting cash finality.

## Core rules
- `provider_payment_id != tx_hash`
- `provider_settlement_id`, `batch_reference`, and allocation are separate concepts.
- One provider payment can have `0 tx_hash`, `1 tx_hash`, or be included in batch settlement.
- One batch settlement can allocate to `N` provider payments.
- `presented` is a shop-side presentation state, not provider cash finality.
- Provider accepted/captured are payment evidence only.
- Provider accepted/captured do not directly create `invoice.status=paid`.

## Evidence semantics
- Provider payment events are sidecar evidence.
- Provider settlement reports are sidecar evidence.
- Reconciliation links connect provider payment, provider settlement, and on-chain transfer evidence.
- Batch allocation support must not assume `1 tap = 1 tx_hash`.

## Separation of concepts
- `cancel` is not `void`.
- `void` is not `refund`.
- Provider `voided` evidence must not be rewritten into staff `cancelled` semantics just because the invoice state machine has no dedicated void state.
- Provider refund is not on-chain refund.
- Grant and grant reversal are out of scope for this phase.
- provider-side `failed` / `voided` is not the same thing as staff choosing to resume QR guidance.
- QR fallback after tap presentation requires explicit staff action so the system never re-opens a second customer rail ambiguously.

## Privacy rules
- Private and personal artifacts stay out of payment ledger rows and settlement export rows.
- Raw provider payload is not stored in provider payment events for v1.
- Only payload hash and canonicalized evidence fields are retained.

## Done when
- Provider evidence can be stored without changing the meaning of `paid`.
- Batch settlement/allocation can be represented without destructive schema changes.
- Refund, cancel, void, and grant semantics remain separate.
- terminal UI can show `受付待ち / 認証中 / 商品渡しOK / 要再試行 / 要確認` without redefining ledger semantics.
