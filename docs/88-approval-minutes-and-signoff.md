# 承認議事録・決裁記録（88-approval-minutes-and-signoff）

## Goal
release verdict を確定する会議記録に、machine verdict、人間判断、approval ref、署名、次アクションを 1 枚で残す。

## Context
- machine verdict の正本は `commercial-go-validation.json` / `COMMERCIAL_GO_SUMMARY.md`。
- human signoff の正本は本議事録と `docs/97-commercial-release-record-template.md`。
- 2026-04-22 時点の最新 machine verdict は `NO_GO`。

## Constraints
- 未取得の approval ref や external evidence を捏造しない。
- `NO_GO` を `GO` に言い換えない。
- `Conditional-Go` を選ぶ場合、期限・責任者・解除条件を必須にする。

## Meeting record
- 会議日時:
- 開催方法:
- 記録者:
- 対象環境:
- 対象リリース:

## Attendance
| Role | Name | Present (yes/no) | Sign ref |
|---|---|---|---|
| 法務責任者 |  |  |  |
| 会計責任者 |  |  |  |
| 運用責任者 |  |  |  |
| 技術責任者 |  |  |  |
| セキュリティ責任者 |  |  |  |

## Evidence package
- Production validation PASS ref:
- Latest `COMMERCIAL_GO_SUMMARY.md` ref:
- `commercial-go-validation.json` ref:
- `commercial-go-scorecard.md` ref:
- Docker `docker build .` ref:
- Docker `docker compose -f docker-compose.prod.yml config` ref:
- `EXT-001` ref:
- `EXT-002` ref:
- `EXT-003` ref:
- `EXT-004` ref:
- `POC-001` ref:
- `POC-002` ref:
- `POC-003` ref:

## Gate signoff
| Gate | Decision (`Approved / Approved with Conditions / Deferred / Rejected`) | approval_ref / evidence_ref | Owner | Conditions / due date |
|---|---|---|---|---|
| A-1 Legal |  |  |  |  |
| A-2 AML |  |  |  |  |
| A-3 Privacy |  |  |  |  |
| A-4 APPI |  |  |  |  |
| A-5 JPYC contract |  |  |  |  |
| A-6 confirmations / backscan |  |  |  |  |
| A-7 refund / non-custodial ops |  |  |  |  |
| A-8 release verdict |  |  |  |  |

## Verdict
- Machine verdict (`NO_GO / CONDITIONAL_NO_GO_FOR_COMMERCIAL / COMMERCIAL_GO / COMMERCIAL_GO_10`):
- Human meeting verdict (`NO-GO / CONDITIONAL-GO / GO`):
- Limited-pilot verdict (`not ready / conditionally ready / ready`):
- Commercial-prep verdict (`not ready / conditionally ready / ready`):
- Signed minutes ref:

## External blockers left open
- EXT-001:
- EXT-002:
- EXT-003:
- EXT-004:
- POC-001:
- POC-002:
- POC-003:
- Docker-capable host validation:

## Action items
| ID | Action | Owner | Due date | Close evidence |
|---|---|---|---|---|
| ACT-001 |  |  |  |  |
| ACT-002 |  |  |  |  |
| ACT-003 |  |  |  |  |

## Done when
- signed minutes から verdict と根拠の両方を辿れる。
- `docs/97-commercial-release-record-template.md` と同じ verdict / approval ref が記録されている。
