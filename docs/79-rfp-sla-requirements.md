# 79. RFP文面 / SLA要件

## Goal
外部ベンダーへ提示する最低要求を固定し、契約前レビューの抜け漏れを防ぐ。

## Required service level
- 月間可用性: `>= 99.9%`
- P1 初動応答: `<= 30分`
- 障害通知: メールまたは webhook で即時通知
- planned maintenance 告知: `>= 7日` 前
- 認証付き管理画面または API
- 監査証跡の保持

## Contract requirements
- RTO / RPO は契約書または付随覚書に明記し、release record に保存する。
- API レート上限、burst 制限、サポート窓口、エスカレーション経路を明記する。
- データ取扱い、ログ保存、地域制約がある場合は法務レビューを完了させる。

## Approval path
- 法務レビュー
- 会計影響レビュー
- 技術責任者による failover / 運用適合確認

## Done when
- 発注前レビュー会議に提出できる要件一覧として使える。
