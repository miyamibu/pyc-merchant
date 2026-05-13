# 52. Exception Detection

## Goal
自動処理不能な着金を検知してレビューへ確実に送る。

## Detection Targets
- wrong_chain
- wrong_token
- wrong_recipient
- shortage
- overpay
- late_arrival
- duplicate
- ambiguous / unmatched transfer

## Storage
- invoice: `status=review_required`
- `review_cases`
- `chain_unmatched_events`

## Done when
- `wrong_chain` / `wrong_token` ケースがスモークで実行される。
- レビュー一覧から追跡可能。
