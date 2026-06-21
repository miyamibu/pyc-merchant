# Commercial Go Runbook

## Goal
commercial verdict を、同じコマンド列と同じ verdict 名で再現できるようにする。

## Baseline
- Node 24.17.0 を使用する。
- evidence を repo の正本に増やしたくない場合は `mktemp -d` を使う。

## Command sequence
1. `npm run check`
2. `npm test`
3. `npm run audit`
4. `npm run test:smoke`
5. `npm run test:audit-chain`
6. `npm run deploy:check`
7. `PRODUCTION_EVIDENCE_ROOT="$(mktemp -d)" COMMERCIAL_EVIDENCE_ROOT="$(mktemp -d)" npm run production:validate`
8. `COMMERCIAL_EVIDENCE_ROOT="$(mktemp -d)" npm run commercial:validate`

Docker が使える host では追加で以下を実行し、release record に残す。
9. `docker build .`
10. `docker compose -f docker-compose.prod.yml config`

## Machine verdict rules
- `NO_GO`
  P0 blocker が残る。
- `CONDITIONAL_NO_GO_FOR_COMMERCIAL`
  P0=0 だが external evidence または POC package が未完。
- `COMMERCIAL_GO`
  P0=0 かつ `EXT-001..004` pass。
- `COMMERCIAL_GO_10`
  `COMMERCIAL_GO` に加えて `POC-001..003` pass。

## Operator note
- human meeting verdict の `CONDITIONAL-GO` と machine verdict の `CONDITIONAL_NO_GO_FOR_COMMERCIAL` は別概念であり、同じ意味として扱わない。両方をそのまま記録する。
