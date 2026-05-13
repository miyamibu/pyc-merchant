# Gate判定ブック（85-gate-decision-book）

## Goal
承認ゲートごとの根拠、runtime enforcement、release owner を一枚で確認できるようにする。

## Gate registry
| Gate | Scope | Runtime enforcement | Evidence source | Release owner |
|---|---|---|---|---|
| A-1 | 法務境界 | `LEGAL_GATE_APPROVED` | `LEGAL_GATE_APPROVAL_REF` | 法務責任者 |
| A-2 | AML方針 | `AML_POLICY_APPROVED` | `AML_POLICY_APPROVAL_REF` | 法務責任者 + 会計責任者 |
| A-3 | プライバシー方針 | `PRIVACY_POLICY_APPROVED` | `PRIVACY_POLICY_APPROVAL_REF` | 法務責任者 |
| A-4 | APPI運用 | `APPI_POLICY_APPROVED` | `APPI_POLICY_APPROVAL_REF`, `APPI_RETENTION_POLICY_REF`, `APPI_DELETION_PROCEDURE_REF`, `APPI_DISCLOSURE_PROCEDURE_REF` | 法務責任者 |
| A-5 | JPYC contract | `APPROVED_JPYC_TOKEN_CONTRACT`, `TOKEN_DECIMALS`, `JPYC_BASE_UNIT_SCALE` | `JPYC_CONTRACT_APPROVAL_REF` | 技術責任者 |
| A-6 | confirmations / backscan | `REQUIRED_CONFIRMATIONS`, `MIN_REQUIRED_CONFIRMATIONS`, `MONITOR_BACKSCAN_BLOCKS`, `MIN_MONITOR_BACKSCAN_BLOCKS` | `CONFIRMATIONS_POLICY_APPROVAL_REF`, `BACKSCAN_POLICY_APPROVAL_REF` | 技術責任者 |
| A-7 | refund / non-custodial運用 | refund verification rules | runbook と release evidence | セキュリティ責任者 + 運用責任者 |
| A-8 | release verdict | machine verdict + signed verdict | [Approval Minutes and Signoff](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/88-approval-minutes-and-signoff.md), [Commercial Release Record Template](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/97-commercial-release-record-template.md) | 四責任者 |

## Exit criteria for release
- A-1 から A-7 の evidence が揃っている。
- startup validation が通る。
- [Go/No-Go Checklist](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/91-go-no-go-checklist.md) の証跡が揃っている。

## Done when
- gate 判定と deployment env の整合が release record から確認できる。
