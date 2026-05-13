# 01. Gap Analysis

## Goal
限定店舗の実証リリース直前時点で、コードで解消済みの項目と外部検証待ちの項目を切り分ける。

## Context
- バックエンド、台帳、監査、運用スクリプト、本番配備パックはリポジトリ内に実装済み。
- 残る主要ギャップは実機確認、実JPYC少額決済、TLS証明書配置、本番サーバ投入のような外部依存である。
- 早期フェーズの設計メモは残すが、最新判断は [`docs/00-current-state.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/00-current-state.md) と [`docs/90-production-validation-plan.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/90-production-validation-plan.md) を優先する。

## Constraints
- 未実行の外部検証を「完了」と書かない。
- non-custodial 方針を崩す実装でギャップを埋めない。
- 限定店舗実証リリースに不要な広域スケール対応は次論点として扱う。

## P0: Go/No-Go blockers
| No | 項目 | 現状 | 必要状態 | 判定 |
|---|---|---|---|---|
| P0-1 | 実機ウォレット起動 | 検証スクリプトとチェックリストは整備済み | iOS/Android 実機で証跡取得 | 外部実行待ち |
| P0-2 | 実JPYC少額決済 | REAL_PAYMENT_MODE 対応済み | 少額送金と着金反映の証跡取得 | 外部実行待ち |
| P0-3 | TLS / 本番ホスト | nginx/systemd/compose は整備済み | 証明書配置と本番DNS反映 | 外部実行待ち |
| P0-4 | 店舗オペレーション訓練 | runbook と checklist は整備済み | スタッフ導線と障害訓練の署名付き記録 | 外部実行待ち |

## P1: Limited pilot quality
| No | 項目 | 現状 | 必要状態 |
|---|---|---|---|
| P1-1 | 自動検証パック | 実装済み | release candidate ごとに evidence を残す |
| P1-2 | 本番デプロイ再現性 | 実装済み | 実サーバ上で preflight から restore drill まで実行 |
| P1-3 | 外向け資料 | 更新済み | 協力先・補助金申請に合わせて都度差分更新 |

## P2: Post-pilot expansion
| No | 項目 | 現状 | 次の論点 |
|---|---|---|---|
| P2-1 | 複数店舗 / 複数ノード運用 | MVP対象外 | DB / queue / observability の拡張 |
| P2-2 | 高負荷スケール設計 | SQLite 前提 | Postgres などへの移行判断 |
| P2-3 | 対応チェーン拡張 | Polygon のみ | 対応範囲と審査フローの再設計 |

## Done when
- コードで完了した項目と人間側の外部依存が分離されている。
- Go/No-Go 判定で見るべき未完了項目が明確である。
