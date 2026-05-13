# 77. 障害訓練台本

## Goal
想定障害の訓練で運用手順を検証する。

## Drill Cases
1. RPC全断（worker stale）
2. dead-letter 多発
3. 期限後着金増加
4. refund承認者不在
5. 監査ログ改ざん検知失敗
6. address pool 枯渇
7. verified manual ingest failure
8. refund verification failure

## Flow
1. 訓練開始宣言
2. 検知時刻記録
3. 初動手順実施
4. 復旧判定
5. 振り返り（改善項目）

## Record Template
- 事象:
- 検知チャネル:
- 初動完了時刻:
- 復旧時刻:
- 改善項目:
- 監査ログ確認結果:
- kill switch 実施有無:

## Done when
- 主要ケースを最低1回ずつ演習済み。
