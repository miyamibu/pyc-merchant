# 本番検証計画（90-production-validation-plan）

## Goal
limited-store pilot 直前に、コード、deployment pack、wallet launch payload、運用証跡準備を同じ手順で再現できるようにする。

## Context
- support baseline は Node 24.17.0。
- `npm run production:validate` は repo/deploy validation pack を生成する。
- 実機、実送金、公開 TLS は external evidence として別管理する。

## Evidence directory
- default local validation output: `artifacts/production-validation-evidence/<timestamp>/`
- real private launch evidence remains outside git under [docs/production/evidence](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/evidence) and must not be committed.
- override when needed: `PRODUCTION_EVIDENCE_ROOT="$(mktemp -d)" npm run production:validate`
- 実行結果:
  - `artifacts/production-validation-evidence/<timestamp>/SUMMARY.md`
  - 各 step の `.log` / `.json`

## Validation steps
| Step | Command / script | Result type |
|---|---|---|
| Static quality | `npm run check` | Required pass |
| Test suite | `npm test` | Required pass |
| Serialized diagnostic re-run | `npm run test:serial` | Optional diagnostic |
| Dependency audit | `npm run audit` | Required pass |
| Smoke flow | `npm run test:smoke` | Required pass |
| Audit chain verify | `npm run test:audit-chain` | Required pass |
| Deploy pack check | `npm run deploy:check` | Required pass |
| Production drift check | `node scripts/production-validation/validate-production-config.mjs` | Required pass |
| Dependency / Docker hygiene | `node scripts/production-validation/validate-dependency-docker-hygiene.mjs` | Required pass |
| Public invoice API | `node scripts/production-validation/validate-public-invoice-api.mjs` | Required pass |
| Wallet launch payload | `node scripts/production-validation/validate-wallet-launch.mjs` | Required pass |
| Smoke payment flow wrapper | `node scripts/production-validation/validate-smoke-payment-flow.mjs` | Pass + external pending allowed |
| Backup | `bash scripts/deploy/backup-sqlite.sh` | Required pass |
| Restore drill | `bash scripts/deploy/restore-drill.sh` | Required pass |
| Evidence sanitization | `node scripts/production-validation/validate-evidence-sanitization.mjs --evidence-dir <dir>` | Required pass |

## Drift continuity
- `npm run deploy:check`
  `.env.production.example` に対して syntax と dry-run drift を確認する。
- `npm run production:validate`
  実行時 env と evidence pack を一括確認する。
- `npm run production:validate:env`
  実値 `.env.production` がある環境で drift と RPC 到達確認を 1 コマンドで実行する。
- `.github/workflows/ci.yml`
  Node 24.17.0 で `npm ci`, `npm run check`, `npm test`, `npm run audit`, `npm run test:smoke`, `npm run test:audit-chain`, `npm run deploy:check`, `docker build .`, `docker compose -f docker-compose.prod.yml config` を実行する。

## Docker off-host validation
- ローカルに Docker がない場合は repo fail とみなさず、`environment limitation` として記録する。
- その場合は Docker-capable host で以下を実行し、結果を release record に残す。
  - `docker build .`
  - `docker compose -f docker-compose.prod.yml config`
- 最低限、実行 host、実行日時、branch/revision、pass/fail、ログ保存先を残す。

## External evidence helper
- `npm run evidence:external:prepare`
- 生成先:
  - `EXT-001-real-jpyc-payment.md`
  - `EXT-002-wallet-device-launch.md`
  - `EXT-003-public-fqdn-tls.md`
  - `EXT-004-store-ops-drill.md`
  - `POC-001.md`
  - `POC-002.md`
  - `POC-003.md`
- `EXT-002-hashport-device-launch.md` は backward-compatible alias であり、canonical file 名ではない。

## External pending group
以下はコードではなく外部環境が必要なため、未実行なら `external pending` として残す。
- 実 JPYC 少額決済
- HashPort Wallet 実機確認
- 公開 TLS ホスト確認
- 限定店舗スタッフによる締め処理 / incident drill
- paid PoC KPI evidence

詳細は [BLOCKED_EXTERNAL_VALIDATION](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/BLOCKED_EXTERNAL_VALIDATION.md) を正本とする。

## Verdict
- `GO`
  required pass がすべて緑で、limited pilot に必要な external evidence も閉じている。
- `NO-GO`
  required pass に fail がある、または required external evidence が未実行。
- `CONDITIONAL-GO`
  人間会議で guardrail を付けて限定運用する場合のみ許可する。machine verdict 名とは別概念で扱う。

## Failure handling
- fail は `NO-GO`
- external pending は `GO` に格上げしない
- 実送金・実機の結果は推測で埋めない
