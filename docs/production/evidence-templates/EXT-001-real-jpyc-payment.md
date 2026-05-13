# EXT-001 Real JPYC Payment

- status: pending
- actual_tx_hash:
- invoice_id:
- amount:
- expected_amount_atomic:
- block_number:
- block_timestamp:
- detected_at:
- status_transition:
- screenshot_ref:
- log_ref:
- tester:
- checked_at:
- run_command: `REAL_PAYMENT_MODE=1 node scripts/production-validation/validate-smoke-payment-flow.mjs`

## Goal
実JPYC少額決済を実施し、invoice 状態遷移と on-chain 証跡を一致させる。

## Constraints
未実施を pass にしない。placeholder tx hash を入れない。

## Done when
status=pass かつ required fields が埋まっている。
