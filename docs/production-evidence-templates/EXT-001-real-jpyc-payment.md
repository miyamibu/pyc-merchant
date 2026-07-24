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

実JPYC少額決済を実施し、invoice状態遷移とon-chain証跡を一致させる。

## Constraints

未実施をpassにしない。placeholder tx hashを入れない。

## Done when

status=passかつrequired fieldsが埋まっている。
