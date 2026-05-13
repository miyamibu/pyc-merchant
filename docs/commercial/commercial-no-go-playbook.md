# Commercial No-Go Playbook

## Trigger
- `npm run commercial:validate` verdict が `NO_GO`
- `npm run commercial:validate` verdict が `CONDITIONAL_NO_GO_FOR_COMMERCIAL`

## Response
1. P0 blocker がある場合は repo-internal issue を先に修正する。
2. P1 / P2 だけの場合は `EXT-001..004` と `POC-001..003` の owner / due date を割り当てる。
3. Docker 未実行が理由なら `environment limitation` と記録し、Docker-capable host へ owner を割り当てる。
4. 設定を fail-open にせず、`/readyz` not ready または pending verdict を維持する。
5. 再検証して scorecard と release record を更新する。

## Exit
- `NO_GO` は P0=0 になってから抜ける。
- `CONDITIONAL_NO_GO_FOR_COMMERCIAL` は external evidence が closing されたら再判定する。
