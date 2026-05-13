# Go/No-Go証跡マトリクス（87-go-no-go-evidence-matrix）

## Goal
release verdict に必要な証跡と、その証跡をどこで確認するかを固定する。

詳細な MVP Done 条件の母表は [95-mvp-done-evidence-matrix](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/95-mvp-done-evidence-matrix.md) を参照。

## Evidence matrix
| G-ID | Check item | Required evidence | Runtime guard or test | Reviewer |
|---|---|---|---|---|
| G-001 | 法務承認 | `LEGAL_GATE_APPROVAL_REF` | production startup validation | 法務責任者 |
| G-002 | 会計承認 | 会計承認記録、日次締め方針 | settlement tests + signoff | 会計責任者 |
| G-003 | 運用承認 | runbook 承認、当番体制記録 | [Runbook](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/74-runbook.md) | 運用責任者 |
| G-004 | 技術承認 | change review、validation logs、commercial verdict output | `npm run check`, `npm test`, `npm run audit`, `npm run test:smoke`, `npm run commercial:validate` | 技術責任者 |
| G-005 | 実JPYC少額決済PASS | 少額実送金の tx hash 記録 | release evidence | 技術責任者 |
| G-006 | 期限後着金レビューPASS | late payment 試験結果 | automated tests + real-chain evidence | 技術責任者 |
| G-007 | 重複支払いレビューPASS | duplicate payment 試験結果 | automated tests | 技術責任者 |
| G-008 | 返金フローPASS | refund verification 記録 | automated tests + runbook execution log | 運用責任者 + 会計責任者 |
| G-009 | 日次締めPASS | settlement close 記録 | automated tests + business-day close evidence | 会計責任者 |
| G-010 | 緊急停止/復旧PASS | incident drill 記録 | drill script + audit log | 運用責任者 |
| G-011 | 監査ログ整合PASS | audit export と verify-chain 結果 | `npm run test:audit-chain` | 技術責任者 |
| G-012 | 秘密情報管理PASS | secret inventory、non-custodial 境界承認 | startup validation + signoff | セキュリティ責任者 |

## Commercial verdict artifacts
- `commercial-go-validation.json`
- `commercial-go-scorecard.md`
- `COMMERCIAL_GO_SUMMARY.md`

上記は G-004 の技術承認と最終 release record の両方で参照する。

## Done when
- G-001 から G-012 の証跡が release record で確認できる。
