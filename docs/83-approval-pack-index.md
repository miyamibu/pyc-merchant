# 承認パック一式（83-approval-pack-index）

## Goal
実装済み core に対する limited-store pilot / commercial-prep の最終人間承認を、機械判定と signed records の両方で漏れなく閉じる。

## Context
- `docs/production/evidence/20260421T163407Z/SUMMARY.md` は repo/deploy validation `PASS`。
- `docs/production/evidence/20260422T021726Z/COMMERCIAL_GO_SUMMARY.md` は `NO_GO`。
- つまり会議の論点は「実装するかどうか」ではなく、「何が repo 内で完了し、何が external pending か」を確認して責任を割り当てること。

## Constraints
- 未確認事項を `Approved` にしない。
- 口頭合意のみで終了しない。必ず記録を残す。
- 外部 pending を human verdict で隠さない。
- machine verdict 名は `NO_GO / CONDITIONAL_NO_GO_FOR_COMMERCIAL / COMMERCIAL_GO / COMMERCIAL_GO_10` をそのまま使う。

## Pack contents
| No | 文書 | 用途 | 使うタイミング |
|---|---|---|---|
| 80 | `docs/80-approval-plan.md` | gate と approval ref の正本 | 会議前の前提確認 |
| 83 | `docs/83-approval-pack-index.md` | 入口と全体フロー | 会議開始前 |
| 84 | `docs/84-approval-meeting-runbook.md` | 進行台本、時間配分、司会スクリプト | 会議中 |
| 85 | `docs/85-gate-decision-book.md` | A-1〜A-8 の判断材料 | 会議中 |
| 87 | `docs/87-go-no-go-evidence-matrix.md` | G-001〜G-012 の証跡照合 | 会議後半 |
| 88 | `docs/88-approval-minutes-and-signoff.md` | 議事録、決裁、署名記録 | 会議終了時 |
| 89 | `docs/89-conditional-go-guardrails.md` | Conditional-Go の運用制限 | 条件付き時のみ |
| 96 | `docs/96-commercial-go-scorecard.md` | commercial verdict 名と gate map の正本 | 会議前の判定用語合わせ |
| 97 | `docs/97-commercial-release-record-template.md` | 最終 release record | 会議終了後の正本 |

## Source of truth
| Topic | Canonical source |
|---|---|
| Approval gate definition | `docs/80-approval-plan.md` |
| Execution order and remaining blockers | `docs/82-execution-roadmap.md` |
| Production validation result | `docs/production/evidence/20260421T163407Z/SUMMARY.md` |
| Latest commercial verdict | `docs/production/evidence/20260422T021726Z/COMMERCIAL_GO_SUMMARY.md` |
| External pending items | `docs/production/BLOCKED_EXTERNAL_VALIDATION.md` |
| Final release record | `docs/97-commercial-release-record-template.md` |

## Meeting flow
1. `96` で machine verdict と gate 名の意味を揃える。
2. `80` と `85` で A-1〜A-8 の approval ref と owner を確認する。
3. `87` と `docs/production/BLOCKED_EXTERNAL_VALIDATION.md` で repo-internal pass と external pending を切り分ける。
4. `88` に会議記録、条件、署名、次アクションを残す。
5. `97` に最終 release record を転記する。
6. `Conditional-Go` の場合のみ `89` を閉じる。

## Pre-meeting checklist
| Check | 内容 | Owner | Status |
|---|---|---|---|
| P-01 | 法務/会計/運用/技術/セキュリティ責任者の出席確認 | PM | Pending |
| P-02 | `SUMMARY.md` と `COMMERCIAL_GO_SUMMARY.md` の最新版を共有 | PMO | Pending |
| P-03 | `.env.production` 実値差し込み担当と approval ref owner を確認 | 技術責任者 | Pending |
| P-04 | `EXT-001..004` と `POC-001..003` の pending owner を割り当て | PM | Pending |
| P-05 | 記録者が `docs/88` と `docs/97` を同時更新できる状態にする | PM | Pending |

## Output format
- `Machine verdict`: `NO_GO / CONDITIONAL_NO_GO_FOR_COMMERCIAL / COMMERCIAL_GO / COMMERCIAL_GO_10`
- `Human meeting verdict`: `NO-GO / CONDITIONAL-GO / GO`
- すべての判定に `Date`, `Owner`, `Evidence`, `Follow-up`, `approval_ref/sign_ref` を記録する。

## Validation method
1. A-1〜A-8 が `docs/80-approval-plan.md` と一致していることを確認する。
2. G-001〜G-012 が `docs/87-go-no-go-evidence-matrix.md` と一致していることを確認する。
3. `docs/88` と `docs/97` に同じ meeting verdict と machine verdict が残ることを確認する。
4. external pending が `Approved` に書き換わっていないことを確認する。

## Failure-handling behavior
- 参加責任者が不足した場合は該当 gate を `Deferred` とし再開催する。
- 証跡不足がある項目は `Pending` のまま `NO-GO` または `CONDITIONAL-GO` とする。
- machine verdict と人間の最終判断がズレる場合、理由・期限・解除条件を `docs/88` に必ず記録する。

## Done when
- 会議後に判定、条件、証跡、署名、次アクションが一式で追跡できる。
- repo-internal 完了項目と external pending 項目が混ざらずに読める。
