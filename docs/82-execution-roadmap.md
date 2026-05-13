# 実行ロードマップ（82-execution-roadmap）

## Goal
implemented core を前提に、limited-store pilot readiness と commercial-prep readiness までの残作業を、repo-internal 完了分と external closeout に分けて示す。

## Context
- `docs/production/evidence/20260421T163407Z/SUMMARY.md` は production validation pack `PASS`。
- 最新 canonical commercial verdict `docs/production/evidence/20260427T233711Z/COMMERCIAL_GO_SUMMARY.md` は `NO_GO`。
- よって現在の主題は「Phase 8 を実装するか」ではなく、「repo 側の closeout を完了し、external blocker を明示するか」である。

## Status dashboard
| Workstream | Status | Evidence | Remaining action |
|---|---|---|---|
| Core app / ledger / review / refund verify | Complete | `README.md`, `docs/00-current-state.md`, `src/server.mjs` | なし |
| Chain monitor / dead-letter / checkpoint | Complete | `src/chain-monitor.mjs`, tests | なし |
| Settlement export contract v1 | Complete | `docs/contracts/settlement-export-v1.md`, schema, tests | downstream adapter 設計のみ |
| Deployment pack | Complete | `Dockerfile`, `docker-compose.prod.yml`, `deploy/*` | 実 host / TLS 投入は external |
| Production validation pack | Complete | `docs/production/evidence/20260421T163407Z/SUMMARY.md` | 最新 env 実値での再実行は human 作業 |
| Commercial validator / scorecard | Complete | `npm run commercial:validate`, `npm run commercial:validate:safe`, `docs/96-commercial-go-scorecard.md` | external evidence が揃った時点で再実行 |
| Repo-internal closeout polish (safe validate / policy URL guard / status terminology) | Complete | `scripts/production-validation/run-commercial-validate-safe.mjs`, `scripts/production-validation/validate-commercial-go.mjs`, `public/mobile.js`, `public/terminal.js` | drift が出た場合のみ追従 |
| `.env.production` handoff | Repo-internal ready | `.env.production.example`, `README.md`, `docs/80-approval-plan.md` | approval ref と実値投入 |
| EXT-001..004 evidence flow | Repo-internal ready | `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`, templates, validator | 実機 / 実送金 / TLS / 店舗訓練 |
| POC-001..003 KPI flow | Repo-internal ready | `docs/commercial/phase1-poc-playbook.md`, POC templates | 3件の実 PoC 実施 |
| Approval / signoff pack | Repo-internal ready | `docs/83`, `docs/88`, `docs/97` | 人間会議と署名 |

## Remaining blockers
### External blockers
- 承認済み `.env.production` 実値の投入
- `EXT-001` 実 JPYC 少額決済
- `EXT-002` HashPort Wallet 実機起動
- `EXT-003` 公開 FQDN / TLS
- `EXT-004` 限定店舗スタッフ訓練
- `POC-001..003` KPI evidence
- signed minutes / release record

### Repo-internal blockers
- 現時点では P0/P1 の repo-internal blocker なし。以後は closeout drift（文書整合、validator 追従）を都度解消する。

## Closeout sequence
1. `.env.production` に承認済み値を投入し、`npm run production:validate:env` を実行する。
2. `npm run evidence:external:prepare` で `EXT-001..004` と `POC-001..003` を seed する。
3. `EXT-001..004` を現場で埋め、`npm run commercial:validate:safe`（または `COMMERCIAL_EVIDENCE_ROOT="<dir>" npm run commercial:validate`）を再実行する。
4. 必要な PoC を実施し、`POC-001..003` と KPI scorecard を更新する。
5. `docs/88-approval-minutes-and-signoff.md` と `docs/97-commercial-release-record-template.md` に machine verdict と人間判断を記録する。
6. すべての external blocker が閉じたら `COMMERCIAL_GO` または `COMMERCIAL_GO_10` を再判定する。

## Guardrails
- 実装済み core を pre-implementation 扱いに戻さない。
- external pending を repo 側の pass で上書きしない。
- machine verdict と human verdict のズレは必ず署名付きで説明する。
- MVP accounting output は generic CSV/JSON を正本とし、vendor adapter（`freee`/`マネーフォワード`/`弥生`/direct API）は downstream 変換として扱う。
- MVP の必須導線は QR wallet rail。provider/tap 実運用統合は別スコープとして明示し、未実施を MVP 未完了と混同しない。

## Done when
- repo-internal work が完了し、external pending だけが明示的に残っている。
- limited-store pilot readiness と commercial-prep readiness の差分が evidence ベースで読める。
