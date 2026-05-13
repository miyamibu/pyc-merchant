# 外部承認項目解消ログ（86-open-questions-resolution-log）

## Goal
本番投入を止める論点が、どの runtime gate と approval ref で閉じられるかを整理する。

## Resolution map
| Q-ID | Topic | Closure condition | Runtime enforcement | Evidence owner |
|---|---|---|---|---|
| Q-001 | 運用形態 | 法務承認済みの non-custodial 境界 | `LEGAL_GATE_APPROVED` | 法務責任者 |
| Q-002 | 登録・届出要否 | 法務見解の承認記録 | `LEGAL_GATE_APPROVAL_REF` | 法務責任者 |
| Q-003 | 対応チェーン | `CHAIN_ID=137` と confirmation policy 承認 | startup validation | 技術責任者 |
| Q-004 | JPYC contract | approved contract と approval ref の一致 | startup validation | 技術責任者 |
| Q-005 | 期限と完了判定 | late payment を review に送るテスト証跡 | payment logic + tests | 技術責任者 + 運用責任者 |
| Q-006 | 返金ポリシー | refund verification と運用承認 | refund verification rules | 運用責任者 + 会計責任者 |
| Q-007 | 鍵管理方式 | non-custodial 運用で署名鍵を保持しないこと | code + runbook | セキュリティ責任者 |
| Q-008 | ウォレット対応範囲 | Reown 本番接続条件の承認 | `ENABLE_REOWN`, `REOWN_PROJECT_ID` validation | プロダクト責任者 + 技術責任者 |
| Q-009 | 会計処理方針 | 日次締め、refund、review の承認証跡 | settlement + export controls | 会計責任者 |
| Q-010 | release verdict | Go/No-Go signoff | signed verdict | 四責任者 |

## Operating rule
repo 内には open のまま放置された行を残さない。未解消論点は release blocker として外部 change management に記録し、対応する env gate が揃うまで production を起動しない。

## Done when
- すべての production blocker が runtime gate または signed evidence に結び付いている。
