# 50. Chain Monitoring

## Goal
監視ワーカーの最小運用品質（追跡・障害検知・再処理）を確保する。

## Worker Responsibilities
- `Transfer` 監視
- invoice へのマッチング
- 内部 ingest API 連携（HMAC + timestamp + jti）
- checkpoint 保存
- unmatched / dead-letter 記録
- provider failover 記録

## Matching Policy
- マッチング単位は `receive_address + exact amount` を優先する。
- `receive_address` で 1 件に絞れない場合のみ `single_recipient_fallback` を使うが、address pool 運用では `1 invoice = 1 receive_address` が前提のため曖昧一致を残さない。
- QR 再発行後の旧 QR 着金は旧 invoice 側で `late_arrival` として review に送る。
- `payment_attempts` は `(chain_id, tx_hash, log_index)` で重複抑止し、invoice-first ledger を壊さない。

## Persisted State
- `chain_monitor_state`
- `chain_unmatched_events`
- `chain_dead_letters`
- `chain_rpc_failovers`

## Dead-letter policy
- `chain_dead_letters` は `(chain_id, tx_hash, log_index, invoice_id)` で重複抑止。
- 失敗時は `status=pending` として upsert、重複行を増やさない。
- retry worker が `next_retry_at` 到達分を再送。
- 成功時: `status=resolved`, `resolved_at` 記録。
- 失敗時: `retry_count++` + exponential backoff。
- `retry_count >= MONITOR_DEAD_LETTER_MAX_RETRIES` で `status=abandoned`。

## Checkpoint policy
- ingest 失敗時に dead-letter へ永続保存できた場合は checkpoint を進めてよい。
- dead-letter 永続化に失敗した場合は checkpoint を進めない（fail closed）。

## Failure cases fixed by tests
- RPC timeout / provider failover
- duplicate `(tx_hash, log_index)` ingest
- server restart 後の `confirming` 維持
- 期限後着金の `late_arrival`
- dead-letter retry / abandon

## Production guard
- `APP_ENV=production` で `MONITOR_BACKSCAN_BLOCKS < MIN_MONITOR_BACKSCAN_BLOCKS` は起動失敗。
- `APPROVED_JPYC_TOKEN_CONTRACT` と `JPYC_CONTRACT_APPROVAL_REF` が未設定なら起動失敗。
- `CONFIRMATIONS_POLICY_APPROVAL_REF` と `BACKSCAN_POLICY_APPROVAL_REF` が未設定なら起動失敗。
- `TOKEN_DECIMALS` と `JPYC_BASE_UNIT_SCALE` が不整合なら起動失敗。

## Same policy across components
- chain monitor の paid 候補判定
- verified manual ingest
- refund verification

上記はすべて同じ contract / confirmation policy を参照する。

## Done when
- `/api/v1/chain-monitor/status` で状態確認可能。
- unmatched/dead-letter を一覧取得できる。
