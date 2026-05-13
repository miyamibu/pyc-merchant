# Blocked External Validation

## Goal
repo 内では完了できない実機・実送金・公開ホスト依存の項目を、未実行のまま明確に残しつつ、人間が最短で閉じられる形に整える。

## Context
- repo 側の validation pack は `docs/production/evidence/20260421T163407Z/SUMMARY.md` で `PASS`。
- 商用判定は latest canonical `docs/production/evidence/20260427T233711Z/COMMERCIAL_GO_SUMMARY.md` で `NO_GO`。
- 未解決理由は repo 未実装ではなく、`EXT-001..004` が external pending のままであること。

## Canonical closeout table
| ID | Item | Canonical template | Why still external | Owner | Next action | Planned slot | How to execute | Close only when | Canonical evidence path | Go impact |
|---|---|---|---|---|---|---|---|---|---|---|
| EXT-001 | 実JPYC少額決済 | `EXT-001-real-jpyc-payment.md` | 実ウォレット、実残高、実証店舗、承認済み本番 env が必要 | Finance + Tech lead | 承認済み本番env投入後に少額実送金を1件実施 | release meeting で確定 | `REAL_PAYMENT_MODE=1 node scripts/production-validation/validate-smoke-payment-flow.mjs` | 実送金後に `confirming -> paid` または expected review path が tx hash と一致している | `docs/production/evidence/<timestamp>/EXT-001-real-jpyc-payment.md` | Required |
| EXT-002 | HashPort Wallet 実機起動 | `EXT-002-wallet-device-launch.md` | iOS / Android 実機と HashPort Wallet が必要 | Store ops | iOS/Android 実機で wallet 起動・copy fallback を撮影記録 | 次回店舗検証枠 | `npm run evidence:device:prepare` を実行し、実機確認後に template を記入 | iOS / Android / copy fallback がすべて pass | `docs/production/evidence/<timestamp>/EXT-002-wallet-device-launch.md` | Required |
| EXT-003 | 公開TLSホスト確認 | `EXT-003-public-fqdn-tls.md` | 公開 FQDN、TLS 証明書、nginx 起動環境が必要 | Infra | `pay.miyamibu.xyz` で health/ready/pay 導線を確認 | DNS/TLS反映後の公開検証枠 | `bash scripts/deploy/healthcheck.sh https://pay.miyamibu.xyz/healthz` | HTTPS で `healthz` / `readyz` / `/pay?ref=` が確認できる | `docs/production/evidence/<timestamp>/EXT-003-public-fqdn-tls.md` | Required |
| EXT-004 | 限定店舗オペレーション訓練 | `EXT-004-store-ops-drill.md` | 実店舗スタッフと当日運用導線が必要 | Ops lead | 店頭 drill を実施し署名付き結果を記録 | 店舗訓練日で確定 | `docs/91-limited-store-release-checklist.md` と `docs/93-incident-drill.md` に沿って実施 | 締め処理、review 対応、返金証跡、incident escalation が署名付きで記録される | `docs/production/evidence/<timestamp>/EXT-004-store-ops-drill.md` | Required |

## Pending record minimum
- `status: pending` のまま保持しつつ、少なくとも `blocker reason / owner / next action / planned slot` を記載する。
- due date が未確定でも `planned slot`（例: 次回release meeting、次回店舗検証枠）は必ず残す。
- template の空欄を埋められない場合は、推測入力せず pending 理由を明記する。

## Template seed
- `npm run evidence:external:prepare`
- 同じ evidence dir に `EXT-001..004` と `POC-001..003` を pending 状態で生成する。

## Rule
- 未実行は `pending` のまま記録する。
- `GO` / `COMMERCIAL_GO` 判定時はこの表の `Required` がすべて `status: pass` で閉じていることを確認する。
- `EXT-002-hashport-device-launch.md` は旧 alias であり、canonical file 名は `EXT-002-wallet-device-launch.md` とする。
- 実送金、実機、公開 TLS、店舗訓練は推測で埋めない。
- Docker 再現確認は別途 release record に残すが、`EXT-001..004` の代替にはならない。

## Done when
- external pending の理由と closing method が各 ID ごとに固定されている。
- human owner が template、実行コマンド、完成条件を迷わず追える。
