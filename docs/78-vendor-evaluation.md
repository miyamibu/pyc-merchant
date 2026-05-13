# 78. ベンダー選定表（RPC / 監視 / Reown）

## Goal
production に必要な外部サービスを同一軸で評価し、release record から契約根拠を辿れるようにする。

## Evaluation axes
- 可用性と障害連絡 SLA
- フェイルオーバー可否
- 監査証跡とアクセス制御
- 料金体系
- インシデント時のサポート窓口
- 契約更新・解約条件

## Required decision record
| Category | Minimum requirement | Evidence to retain | Release link |
|---|---|---|---|
| RPC | 複数 endpoint、障害連絡手段、Polygon mainnet 実績 | 契約書、failover 試験記録 | `BACKSCAN_POLICY_APPROVAL_REF` と release record |
| Monitoring | 認証付きメトリクス閲覧、アラート通知、監査証跡 | 契約書、通知試験記録 | release record |
| Wallet / Reown | Project ID 発行、サポート窓口、利用規約承認 | 管理画面証跡、Project ID 管理記録 | deployment secret inventory |

## Done when
- それぞれの category で選定理由と証跡保存先が release record から辿れる。
