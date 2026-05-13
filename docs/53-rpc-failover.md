# 53. RPC Failover

## Goal
RPC障害時に監視停止時間を最小化し、後追いできる証跡を残す。

## Approach
- `RPC_URLS` を優先順で巡回。
- provider失敗時:
  - 次候補へ切替
  - `chain_rpc_failovers` へ記録
  - `chain_monitor_state.worker:last_rpc_failover_at` 更新

## Constraints
- 本番 RPC URL は deployment env だけで管理し、repo に保存しない。
- secret を含む URL はログへ残さない。
- 切替試験結果は release record に保存する。

## Done when
- failover件数と履歴をAPI参照できる。
