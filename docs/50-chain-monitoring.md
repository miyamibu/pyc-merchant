# 50. Chain Monitoring

## Goal
監視ワーカーの最小運用品質（追跡・障害検知・再処理）を確保する。

## Worker Responsibilities
- `Transfer` 監視
- invoice へのマッチング
- 内部 signed API 連携（HMAC + timestamp + jti）
- checkpoint 保存
- unmatched / dead-letter 記録
- provider failover 記録

## Single-writer DB boundary
- `DB_PATH` は app が所有する financial DB。支払・請求・invoice・payment event・settlement の financial tables は app/API だけが書く。
- `WORKER_STATE_DB_PATH` は chain worker が所有する operational state DB。`chain_monitor_state`、`chain_unmatched_events`、`chain_dead_letters`、`chain_rpc_failovers`、`chain_runtime_registry` だけを保持する。
- worker は invoice 候補と過去の payment evidence を signed internal read API で取得し、financial write は既存の signed internal API（payments ingest / reorg / reconciliation）経由で実行する。worker から financial DB を直接開かない。
- app の operational state 参照は worker state DB の read-only 接続を使う。production-like では `WORKER_STATE_DB_PATH` を必須にし、`DB_PATH` と同一パスを拒否する。
- local/test で `WORKER_STATE_DB_PATH` を未設定の場合は chain 別の既定 state path を使う。過去 fixture のみ、未設定時に限り app の read-only legacy fallback を許容する。
- 既存の financial DB に残る旧 operational rows は削除・自動移行しない。切替時は新 state DB の初回 backscan と checkpoint の扱いを運用手順で確認する。

## Matching Policy
- マッチング単位は `receive_address + exact amount` を優先する。
- `receive_address` で 1 件に絞れない場合のみ `single_recipient_fallback` を使うが、address pool 運用では `1 invoice = 1 receive_address` が前提のため曖昧一致を残さない。
- QR 再発行後の旧 QR 着金は旧 invoice 側で `late_arrival` として review に送る。
- `payment_attempts` は `(chain_id, tx_hash, log_index)` で重複抑止し、invoice-first ledger を壊さない。

## Persisted State
- worker state DB (`WORKER_STATE_DB_PATH`):
  - `chain_monitor_state`
  - `chain_unmatched_events`
  - `chain_dead_letters`
  - `chain_rpc_failovers`
  - `chain_runtime_registry`
- financial DB (`DB_PATH`, app/API only): `chain_reorgs` と invoice/payment/settlement の financial records

## Dead-letter policy
- `chain_dead_letters` は `(chain_id, tx_hash, log_index, invoice_id)` で重複抑止。
- 失敗時は `status=pending` として upsert、重複行を増やさない。
- retry worker が `next_retry_at` 到達分を再送。
- 成功時: `status=resolved`, `resolved_at` 記録。
- 再観測時は `observation_count` / `last_observed_at` のみ増加し、再送失敗数とは混ぜない。
- 実際の再送試行は `retry_attempt_count` / `last_attempted_at`、連続失敗は `consecutive_retry_failures` で記録する。
- `consecutive_retry_failures >= MONITOR_DEAD_LETTER_MAX_RETRIES` で `status=abandoned`。
- 旧 `retry_count` は互換表示用であり、abandon判定の根拠にしない。

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
- `TOKEN_DECIMALS=18` と `JPYC_BASE_UNIT_SCALE=1000000` の境界変換がexactでなければ自動認識しない。
- RPC endpointごとにchain ID、token metadata、contract codeを検証し、不一致endpointはquarantineする。

## Same policy across components
- chain monitor の paid 候補判定
- verified manual ingest
- refund verification

上記はすべて同じ contract / confirmation policy を参照する。

## Done when
- `/api/v1/chain-monitor/status` で状態確認可能。
- unmatched/dead-letter を一覧取得できる。
