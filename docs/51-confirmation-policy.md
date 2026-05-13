# 51. Confirmation Policy

## Goal
入金確定の扱いをチェーン監視と端末表示で統一する。

## Policy
- `REQUIRED_CONFIRMATIONS` 既定: `2`
- `confirmations < required`: `confirming`
- `confirmations >= required` かつ一致条件成立: `paid`
- 不一致条件: `review_required`

## Non-Happy Paths
- `expired` 後着金: `review_required`
- `paid` 後重複: `review_required`

## Done when
- payment event の confirmation 更新がDB反映される。
- 状態遷移が `scripts/smoke-test.mjs` で固定化される。
