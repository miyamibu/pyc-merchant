# Commercial Go Implementation Report

## Goal
限定店舗実証Readyから、商用展開Go判定を fail-closed で運用できる状態へ引き上げる。

## Scope Implemented
- 商用Go判定スクリプト
- `/readyz` 商用ランタイムゲート
- JPYC決済事故対応キューの canonical reason code 統一
- 返金証跡レジストリ強化（non-custodial継続）
- 日次締め export / settlement evidence pack
- 外部証跡テンプレート（EXT-001..004 / POC-001..003）
- 商用ドキュメント（scorecard / release record / runbook）
- 商用Go回帰テスト10本追加

## Key Changes
- `npm run commercial:validate` を追加。
- `scripts/production-validation/validate-commercial-go.mjs` を新規追加。
- `scripts/production-validation/validate-commercial-evidence.mjs` をモジュール化し、EXT/POC判定を再利用化。
- `scripts/production-validation/validate-commercial-scorecard.mjs` を追加し、validation output dir に `commercial-go-scorecard.md` を生成。
- `scripts/production-validation/generate-settlement-evidence-pack.mjs` を追加し、証跡パックを生成。
- `/readyz` で commercial gate 詳細を返すよう更新。
- commercial mode で invoice create/reissue を `COMMERCIAL_GATE_BLOCKED` で fail-closed 化。
- review reason code を canonical (`OVERPAYMENT` など) に統一。
- settlement export に `merchant/store/terminal/operator/event/booth`, `reason_code`, `block_timestamp`, `detected_at`, `audit_ref` を追加。
- refund schema に `audit_log` カラムを追加。

## Added/Updated Docs
- `docs/96-commercial-go-scorecard.md`
- `docs/97-commercial-release-record-template.md`
- `docs/98-commercial-go-implementation-report.md`
- `docs/commercial/phase1-poc-playbook.md`
- `docs/commercial/poc-kpi-scorecard-template.md`
- `docs/commercial/wallet-device-evidence-matrix.md`
- `docs/commercial/commercial-go-runbook.md`
- `docs/commercial/commercial-no-go-playbook.md`
- `docs/production/evidence/templates/EXT-001-real-jpyc-payment.md`
- `docs/production/evidence/templates/EXT-002-wallet-device-launch.md`
- `docs/production/evidence/templates/EXT-003-public-fqdn-tls.md`
- `docs/production/evidence/templates/EXT-004-store-ops-drill.md`
- `docs/production/evidence/templates/POC-001-template.md`
- `docs/production/evidence/templates/POC-002-template.md`
- `docs/production/evidence/templates/POC-003-template.md`
- `docs/production/evidence/templates/JPYC-CONTRACT-VERIFICATION.md`

## Tests Added
- `tests/commercial-go-validation.test.mjs`
- `tests/commercial-evidence-templates.test.mjs`
- `tests/commercial-production-gates.test.mjs`
- `tests/reason-code-normalization.test.mjs`
- `tests/settlement-evidence-pack.test.mjs`
- `tests/refund-evidence-registry.test.mjs`
- `tests/invoice-lineage-commercial.test.mjs`
- `tests/multi-merchant-event-booth.test.mjs`
- `tests/dangerous-production-flags.test.mjs`
- `tests/readyz-commercial-gates.test.mjs`

## Validation Results
- `npm run check`: pass
- `npm test`: pass
- `npm run audit`: pass (0 vulnerabilities)
- `npm run test:smoke`: pass
- `npm run test:audit-chain`: pass
- `npm run deploy:check`: pass
- `npm run production:validate`: pass
- `npm run commercial:validate`: pass (JSON / scorecard / summary generated in validation output dir)

## Current Commercial Verdict
- Verdict: `NO_GO`
- Reason: 外部証跡未完了 + production/commercial承認ゲート未充足を正しく fail-closed で検知
- Latest JSON / Summary / Scorecard: latest validation output dir を参照

## Remaining External Evidence (not auto-completed)
- EXT-001 Real JPYC payment
- EXT-002 HashPort Wallet iOS/Android device validation
- EXT-003 Public FQDN/TLS validation
- EXT-004 Non-crypto staff operations drill
- POC-001..003 paid PoC KPI evidence

## 9.0 Reach Condition
- P0 blockers を 0 にし、EXT-001..004 をすべて `status=pass` で証跡化。
- production + commercial mode の `/readyz` が ready を返す。

## 10.0 Reach Condition
- 上記に加えて POC-001..003 を `status=pass` とし、KPI閾値と signed minutes を揃える。
