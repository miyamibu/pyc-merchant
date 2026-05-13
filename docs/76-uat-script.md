# 76. UAT台本・合否基準

## Goal
本番前受入試験の観点・手順・証跡フォーマットを固定する。

## Test Scenarios
- 正常支払い
- shortage / overpay
- wrong chain / wrong token
- 期限後着金
- refund 申請/承認/実行（二名承認）
- 監査ログ export / hash chain verify
- session 強制失効

## Pass Criteria
- 重要APIが期待ステータスを返す
- `review_required` 振り分けが正しい
- 監査ログに actor/request_id/idempotency_key が残る

## Evidence Template
- 実施日:
- 実施者:
- ケースID:
- 結果(PASS/FAIL):
- スクリーンショット/ログ参照:
- 備考:

## Done when
- UAT実施結果をこのテンプレートで記録できる。
