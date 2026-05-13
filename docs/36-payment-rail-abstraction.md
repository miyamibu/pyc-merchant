# 36. Payment Rail Abstraction

## Goal
Introduce payment rail abstraction without breaking existing wallet-direct invoice behavior.

## Current/default rail
- `wallet_direct` is the current/default rail.
- Existing invoice columns for chain, token, recipient, `paid_amount_jpyc_base`, `paid_tx_hash`, `checkout_session_id`, `status_reason`, and `settled_at` remain in place for compatibility.

## Future rail
- `provider_external` is the future rail for provider-mediated payment UX such as MynaTouch / stera.
- Provider rails are modeled through sidecar tables, not by redefining invoice semantics.

## Payment sessions
- `payment_sessions` is the rail abstraction layer.
- `payment_sessions.fulfillment_decision` is separate from `invoice.status`.
- `fulfillment_decision` may allow shop-side UX, but it must not alter accounting `paid` status.
- Shop-side fulfillment convenience cannot redefine the accounting meaning of `paid`.
- provider/tap rail の店頭開始は `payment_sessions.status=presented` として扱う。
- `presented` は「provider rail を提示中」の意味であり、`paid` でも `captured` でもない。
- terminal UI は `invoice + payment_session + provider_payment_session` を再取得し、`provider_summary` で店頭表示状態を合成する。

## Compatibility rules
- Existing wallet-direct invoice creation and public payment flow remain unchanged.
- New sidecar tables may be populated for new invoices, but export code must fall back gracefully for historical rows with no payment session.
- Provider rails extend payment evidence and reconciliation; they do not become the primary operational ledger.
- same invoice で QR rail と tap rail を同時に顧客向けに開かない。
- tap rail を提示中は fixed QR entry からの wallet 導線を suppress し、QR へ戻す時だけ明示的に resume する。

## Done when
- Wallet-direct remains the default.
- Provider rails can be added through sidecar tables and canonical export mapping.
- `invoice.status=paid` keeps its current on-chain verified meaning.
- `presented -> authorized/captured -> settlement/reconcile` が `invoice.status=paid` と独立して扱える。
