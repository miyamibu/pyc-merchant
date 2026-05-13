# 72. Monitoring and Alerting

## Goal
外部監視未契約でも運用者が状況を把握できる。

## Endpoints
- `/healthz`
- `/readyz`
- `/metrics` (JSON)
- `/api/v1/chain-monitor/status`

## Correlation Log Minimum
- `invoice_id`
- `checkout_session_id`
- `payment_attempt_id`
- `tx_hash`
- `log_index`
- `status`
- `status_version`
- `event_id`
- `merchant_id`
- `store_id`
- `terminal_id`

`invoice.created` / `invoice.reissued` / `payment.processed` / `sse.connected` / `sse.disconnected` を最低限の追跡点とする。

## Watch Items
- DB接続可否
- open/in_progress review件数
- `review_required` 件数
- 未確定 tx 件数
- worker 最終実行時刻
- dead-letter件数
- RPC failover件数
- address pool 残数
- expired invoice件数
- audit hash chain 健全性

## Alert Threshold (初期案)
- worker stale > 3分
- dead-letter > 0
- review backlog > 0 (業務時間中)
- `review_required` 急増
- RPC timeout / failover 増加
- address pool available count 低下
- audit chain verify fail

## Done when
- 端末UIの運用警告欄で主要警告が見える。
- invoice と tx をログだけで突合できる。
