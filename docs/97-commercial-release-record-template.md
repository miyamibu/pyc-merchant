# Commercial Release Record Template

## Goal
商用展開または商用準備継続の最終判断を、machine verdict と human signoff の両方で残す。

## Context
- 対象環境: production / commercial mode
- 対象チェーン: Polygon (`chain_id=137`)
- 対象トークン: JPYC（承認済み contract のみ）

## Constraints
- non-custodial を崩さない。
- サーバー送金署名をしない。
- external evidence 未完了を pass と記載しない。

## Runtime snapshot
- Node baseline: `24.17.0`
- `.env.production` revision:
- `/readyz` snapshot ref:
- `commercial-go-validation.json` ref:
- `COMMERCIAL_GO_SUMMARY.md` ref:
- Docker host / runner:
- `docker build .` result ref:
- `docker compose -f docker-compose.prod.yml config` result ref:

## Signoff matrix
| 項目 | State (`approved / signed / pending / fail`) | approval_ref / sign_ref | approver | approved_at | 備考 |
|---|---|---|---|---|---|
| Legal gate | pending |  |  |  |  |
| AML gate | pending |  |  |  |  |
| Privacy gate | pending |  |  |  |  |
| APPI gate | pending |  |  |  |  |
| JPYC contract approval | pending |  |  |  |  |
| Confirmation policy | pending |  |  |  |  |
| Backscan policy | pending |  |  |  |  |
| Public TLS validation | pending |  |  |  |  |
| Wallet/device validation (HashPort iOS/Android) | pending |  |  |  |  |
| Real JPYC micro payment | pending |  |  |  |  |
| Store ops drill (non-crypto staff) | pending |  |  |  |  |
| Incident drill | pending |  |  |  |  |
| Daily closing evidence | pending |  |  |  |  |
| PoC KPI package (3 paid PoCs) | pending |  |  |  |  |

## Evidence links
- EXT-001:
- EXT-002:
- EXT-003:
- EXT-004:
- POC-001:
- POC-002:
- POC-003:
- Approval minutes:

## Verdict
- Machine verdict (`NO_GO / CONDITIONAL_NO_GO_FOR_COMMERCIAL / COMMERCIAL_GO / COMMERCIAL_GO_10`):
- Human meeting verdict (`NO-GO / CONDITIONAL-GO / GO`):
- Limited-pilot verdict (`not ready / conditionally ready / ready`):
- Commercial-prep verdict (`not ready / conditionally ready / ready`):
- Final decision summary:

## Remaining blockers
- External blockers:
- Repo-internal blockers:
- Environment limitations observed during local verification:

## Done when
- machine verdict と人間の最終判断の両方が追跡できる。
- approval ref と external evidence link が 1 つの文書から辿れる。
