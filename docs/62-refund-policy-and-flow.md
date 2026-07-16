# 62. Refund Policy and Flow

## Goal
返金の申請・承認・実行を分離し、監査可能にする。

## Flow
1. `refund.request`（申請）
2. `refund.approve`（承認）
3. `refund.execute`（実行）
4. `refund.verify`（on-chain verification）
5. verification 成功時のみ `succeeded`

## Control
- 申請者と承認者は同一不可。
- （有効時）承認者と実行者は同一不可。
- `refund_to_address` は EVM address 形式必須。
- `refund_chain_id` は invoice chain と一致必須。
- 適格額を超える申請は `OVER_REFUND` で拒否。
- 承認済み以降の同一 review / 金額 / 返金先 / chain の申請は既存返金へ収束し、別の返金行を作らない。
- 監査ログに request_id / idempotency_key を残す。

## Executor Abstraction
- `manual`
- `external_signer`
- `custody_provider`

## Execution status policy
- `manual` は `recorded`（未検証記録）を返す。
- `external_signer` / `custody_provider` は `pending_verification`。
- `succeeded` は on-chain 検証済みの場合のみ使用。
- `refund_tx_hash` は非NULL時に一意制約で再利用不可。
- `LEGAL_GATE_APPROVED=false` の場合、`external_signer` / `custody_provider` は実行不可。

## Verification rules
- receipt success
- configured chain と一致
- `APPROVED_JPYC_TOKEN_CONTRACT` と一致
- confirmations が policy 以上
- ERC-20 `Transfer` log が存在
- `from_address`, `to_address`, `amount` が expected 値と完全一致
- 不一致は `verification_failed` または review 扱いで止める

## Done when
- APIで二名承認違反が拒否される。
- 実行チャネルと verification 結果がDB記録される。
