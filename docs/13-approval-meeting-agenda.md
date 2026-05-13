# 承認会アジェンダ

## Goal
本番リリース前に、法務・AML・プライバシー・APPI・チェーン設定・運用制御の承認証跡を確認し、release verdict を確定する。

## Required attendees
- 法務責任者
- 会計責任者
- 運用責任者
- 技術責任者
- セキュリティ責任者
- 司会兼記録者

## Agenda
1. `/readyz` の approval summary を確認する。
2. `APPROVED_JPYC_TOKEN_CONTRACT` と `JPYC_CONTRACT_APPROVAL_REF` の一致を確認する。
3. `MIN_REQUIRED_CONFIRMATIONS` / `MONITOR_BACKSCAN_BLOCKS` と各 approval ref を確認する。
4. legal / AML / privacy / APPI の approval ref を確認する。
5. address pool 在庫、kill switch、manual ingest、refund verification の運用証跡を確認する。
6. [Production Validation Plan](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/90-production-validation-plan.md) の結果を確認する。
7. [Go/No-Go Checklist](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/91-go-no-go-checklist.md) に沿って verdict を決定する。

## Decision register
| Decision ID | Scope | Source of truth | Owner |
|---|---|---|---|
| D-01 | 運用モデルと法的境界 | `LEGAL_GATE_APPROVAL_REF` | 法務責任者 |
| D-02 | AML threshold と高額取引運用 | `AML_POLICY_APPROVAL_REF` | 法務責任者 + 会計責任者 |
| D-03 | プライバシー / APPI 運用 | `PRIVACY_POLICY_APPROVAL_REF`, `APPI_*_REF` | 法務責任者 |
| D-04 | Polygon / JPYC / confirmations | `JPYC_CONTRACT_APPROVAL_REF`, `CONFIRMATIONS_POLICY_APPROVAL_REF`, `BACKSCAN_POLICY_APPROVAL_REF` | 技術責任者 |
| D-05 | 返金と監査運用 | refund verification 証跡、日次締め証跡 | 運用責任者 + 会計責任者 |
| D-06 | Release verdict | signed minutes + release record | 四責任者 |

## Output
- 署名済み議事録
- release verdict
- 変更した deployment env 一覧
- 本番投入に残る外部値の有無

## Done when
- D-01 から D-06 の証跡が release record から辿れる。
- 口頭判断だけに依存する項目が残っていない。
