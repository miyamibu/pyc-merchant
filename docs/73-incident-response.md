# 73. Incident Response

## Goal
障害発生時に初動を標準化し、誤操作を防ぐ。

## Severity
- S1: 決済停止 / 重大不整合
- S2: 部分機能停止 / レビュー大量滞留
- S3: 低影響不具合

## Initial Actions (共通)
1. 事象時刻と症状を記録
2. `/readyz`, `/metrics`, chain status を取得
3. 影響範囲（端末数・請求数）確認
4. 暫定回避（手動レビュー運用）を切替

## Needs Human Approval
- 返金方針の例外運用
- 法務・会計上の顧客告知内容
- 本番接続値の差し替え

## Done when
- 障害訓練台本（docs/77）が運用できる。
