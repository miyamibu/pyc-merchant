# Go/No-Goチェックリスト（91-go-no-go-checklist）

## Goal
release verdict を出す前に、どの証跡が揃っていれば判定可能かを固定する。

## Checklist
| ID | Item | Owner | Pass condition |
|---|---|---|---|
| G-001 | 法務承認 | 法務責任者 | `LEGAL_GATE_APPROVAL_REF` が signed minutes に記載されている |
| G-002 | 会計承認 | 会計責任者 | 会計承認記録と日次締め証跡がある |
| G-003 | 運用承認 | 運用責任者 | runbook 承認と drill 記録がある |
| G-004 | 技術承認 | 技術責任者 | `check/test/audit/smoke` が green |
| G-005 | 実JPYC少額決済PASS | 技術責任者 | tx hash ledger がある |
| G-006 | 期限後着金レビューPASS | 技術責任者 | late payment 証跡がある |
| G-007 | 重複支払いレビューPASS | 技術責任者 | duplicate payment 証跡がある |
| G-008 | 返金フローPASS | 運用責任者 | refund verification 証跡がある |
| G-009 | 日次締めPASS | 会計責任者 | settlement evidence がある |
| G-010 | 緊急停止/復旧PASS | 運用責任者 | kill switch と復旧 drill 証跡がある |
| G-011 | 監査ログ整合PASS | 技術責任者 | audit export と verify-chain 結果がある |
| G-012 | 秘密情報管理PASS | セキュリティ責任者 | secret inventory と non-custodial 境界確認がある |

## Verdict rules
- `GO`: すべての項目が pass condition を満たす。
- `CONDITIONAL-GO`: [Conditional-Go Guardrails](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/89-conditional-go-guardrails.md) に収まる条件でのみ許可する。
- `NO-GO`: それ以外。

## Done when
- checklist の各項目に対応する証跡が signed minutes から辿れる。
