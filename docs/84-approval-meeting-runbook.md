# 承認会運営Runbook（84-approval-meeting-runbook）

## Goal
90分〜120分の承認会を脱線なく進行し、implemented core に対する最終承認と external closeout plan を判定付きで閉じる。

## Context
- 本会議は `A-1〜A-8` と `Q-001〜Q-010` の判定を行う正式会議。
- 進行の根拠は `docs/80-approval-plan.md` と `docs/82-execution-roadmap.md`。
- 判定記録は `docs/85`, `docs/86`, `docs/88`, `docs/97` に残す。

## Constraints
- 会議中に実装議論へ逸脱しない。判定に必要な論点に限定する。
- 責任者不在の項目は `Approved` にしない。
- 口頭の「たぶんOK」を禁止し、証跡リンク必須で記録する。

## Roles
| Role | Responsibility | 必須 |
|---|---|---|
| 司会 | 時間管理、判定確認、合意形成 | Yes |
| 記録者 | `docs/88` へリアルタイム記録 | Yes |
| 法務責任者 | A-1, A-2, G-001 | Yes |
| 会計責任者 | A-6, Q-009, G-002, G-009 | Yes |
| 運用責任者 | Q-005, Q-006, G-003, G-008, G-010 | Yes |
| 技術責任者 | A-3, A-4, Q-003, Q-004, G-004, G-005〜G-007, G-011 | Yes |
| セキュリティ責任者 | A-7, Q-007, G-012 | Yes |

## Timeline (120 min)
| Time | Agenda | Input | Output |
|---|---|---|---|
| 00:00-00:10 | 開会・machine verdict確認 | `docs/83`, `docs/96`, 最新 `COMMERCIAL_GO_SUMMARY.md` | 判定用語合意 |
| 00:10-00:35 | 法務・規制ゲート (A-1,A-4) | `docs/80`, `docs/92`, `docs/86` | approval ref 判定更新 |
| 00:35-00:55 | Chain / policy ゲート (A-5,A-6) | `docs/21`, `docs/85` | runtime gate 判定更新 |
| 00:55-01:15 | 運用 / non-custodial ゲート (A-7) | `docs/62`, `docs/73`, `docs/87` | evidence 判定更新 |
| 01:15-01:35 | External blocker と closeout owner 確認 | `docs/82`, `docs/production/BLOCKED_EXTERNAL_VALIDATION.md` | owner / due date 固定 |
| 01:35-01:50 | release verdict (A-8) | `docs/87`, `docs/97` | machine/human verdict 整合 |
| 01:50-02:00 | 最終判定・署名確認 | `docs/88`, `docs/97` | 記録確定 |

## Facilitator Script
### Opening
- 「本会議は承認判定会です。未確定事項は `Deferred` として扱います。」
- 「判定は証跡と責任者名をセットで残します。」

### Gate Confirmation
- 「Gate `A-x` の提案判定は何ですか。」
- 「反対意見または条件はありますか。」
- 「条件がある場合、責任者・期限・解除条件を決めます。」

### Final Decision
- 「machine verdict と human verdict を分けて宣言します。」
- 「`CONDITIONAL-GO` の場合、`docs/89` を閉じるまで本番開始しません。」

## Decision Rules
| Rule ID | Rule |
|---|---|
| R-01 | 必須責任者不在のGateは `Deferred` |
| R-02 | 証跡未提出のGateは `Approved` 不可 |
| R-03 | 法務・会計・鍵管理が `Pending` の場合 `GO` 不可 |
| R-04 | `Conditional-Go` は期限・制限・解除条件を必須化 |
| R-05 | 前提変更時は `Reopen` |

## Meeting Inputs
| Input | Source |
|---|---|
| 承認ゲート定義 | `docs/80-approval-plan.md` |
| 依存関係とブロッカー | `docs/82-execution-roadmap.md` |
| 外部承認項目台帳 | `docs/open-questions.md`, `docs/86` |
| 判定対象証跡 | `docs/87`, `docs/97` |

## Output Format
- `Gate判定表`: Gate ID, Decision, Owner, Evidence, Due Date, Follow-up
- `Open Questions更新表`: Q-ID, Decision, Decision Date, Decision Owner
- `Final Verdict`: machine verdict + human verdict + 理由

## Validation Method
1. すべてのGateについて判定が記録されていること。
2. `Deferred/Conditions` には期限と責任者があること。
3. `docs/88` に会議日時、参加者、最終判定、署名があること。

## Failure-Handling Behavior
- 時間超過時は法務・鍵管理・Go判定を優先し、残件を再会議へ分離する。
- 合意不能時は `NO-GO` としてエスカレーション会議を設定する。

## Done when
- 会議終了時に A-1〜A-8 の判定が確定している。
- 最終判定が記録・署名済みである。
