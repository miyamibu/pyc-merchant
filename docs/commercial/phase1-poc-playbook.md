# Phase 1 PoC Playbook

## Goal
`POC-001..003` の KPI 証跡を、商用判定にそのまま流し込める形で揃える。

## Context
- `COMMERCIAL_GO_10` は `POC-001..003` がすべて `status: pass` であることを要求する。
- repo 側でできることは template、scorecard、release record 導線の整備までであり、実施そのものは外部運用で行う。
- PoC の source of truth は vendor 出力ではなく server-side ledger と settlement evidence である。

## Target PoCs
| ID | Scenario | Primary success picture |
|---|---|---|
| POC-001 | Web3イベント（複数ブース） | booth 単位の運用差分を review / settlement まで再現できる |
| POC-002 | フードホールまたは複数テナント | tenant ごとの締め・照合を崩さず回せる |
| POC-003 | コミュニティバー / カフェ / ポップアップ | 非クリプト専業スタッフでも日次運用を自走できる |

## Constraints
- 初期 payer は「すでに JPYC 支払い可能な層」に限定する。
- 観光客のその場 JPYC 入手を前提にしない。
- non-custodial を崩さない。
- KPI を vendor 任せにせず、ledger / settlement / audit evidence と照合する。

## Required repo artifacts
| Artifact | Purpose | Where to store |
|---|---|---|
| `POC-001.md` / `POC-002.md` / `POC-003.md` | 商用 validator が読む pass/pending/fail の正本 | `docs/production/evidence/<timestamp>/` |
| `docs/commercial/poc-kpi-scorecard-template.md` ベースの scorecard | KPI の生値と閾値判定 | evidence dir か添付資料 |
| 日次締め evidence | KPI の `daily_close_reproduced` 根拠 | settlement evidence pack |
| CSV 照合 evidence | `csv_reconciliation` 根拠 | settlement export / accounting evidence |
| signed minutes | `signed_minutes_ref` 根拠 | `docs/88-approval-minutes-and-signoff.md` or external signoff pack |

## Execution flow
1. `npm run evidence:external:prepare` を実行し、対象 evidence dir に `POC-001..003` を生成する。
2. PoC ごとに KPI scorecard を作成し、QR表示時間、着金検知時間、review 発生率、締め完了時間、スタッフ自力対応率などを実測する。
3. その PoC で使った日次締め evidence、CSV 照合 evidence、運用メモ、signed minutes ref を確定する。
4. 対応する `POC-00x.md` に `status`、`kpi_result`、`daily_close_reproduced`、`csv_reconciliation`、`signed_minutes_ref`、`evidence_ref` を転記する。
5. `COMMERCIAL_EVIDENCE_ROOT="<dir>" npm run commercial:validate` を再実行し、P2 blocker が消えたことを確認する。

## KPI (must measure)
- QR表示時間
- 着金検知時間
- review発生率
- 未解決review件数
- 締め完了時間
- スタッフ自力対応率
- 問い合わせ件数
- 返金証跡完全性
- CSV精算再現性

## Done when
- 3件の PoC それぞれで `POC-00x.md` が `status: pass` になっている。
- KPI scorecard と日次締め evidence と signed minutes が相互参照できる。
- `npm run commercial:validate` が `POC-001..003 KPI evidence not fully pass` を出さない。
