# Phase 3 成果物: DBスキーマ設計（31-db-schema）

## Goal
決済台帳・監査・返金処理に必要な最小DBスキーマを定義し、金融状態遷移の正本を保証する。

## Context
- 現状はDBが存在しない。
- 本設計はRDB（PostgreSQL想定）での実装を前提にする。

## Constraints
- すべての金融状態はサーバーDBで管理する。
- `tx_hash` だけに依存せず、チェーンとログ位置を含めて一意化する。
- 削除ではなく状態遷移で履歴を保持する。

## 金額カラム設計方針（デュアルカラム）

`invoices`, `payment_events`, `refund_requests`, `chain_unmatched_events` の各テーブルには、
金額を表す列が2種類存在する。

| 列名 | 型 | 用途 |
|---|---|---|
| `amount_jpyc` | `REAL` | API レスポンス表示用キャッシュ値（人間可読）|
| `amount_jpyc_base` | `INTEGER` | 金融ロジック正本（整数基本単位）|

**財務比較・集計・判定には必ず `_base` 列（INTEGER）を使用すること。**
`REAL` 列は浮動小数点誤差があるため、金融処理には使用しない。

`JPYC_BASE_UNIT_SCALE` は変換倍率を制御する。
production では approval ref と一致した明示設定を必須化し、未設定時は起動失敗とする。
正規値の確定は `JPYC_CONTRACT_APPROVAL_REF` と会計承認記録に連動して管理する。
変換ロジックは `src/payment-logic.mjs` の `makePaymentLogic()` に集約されている。

## PostgreSQL想定設計とSQLite実装の差分

本ドキュメントは PostgreSQL 想定で設計しているが、現行実装は SQLite (`better-sqlite3`)。
移行時の主な差分は以下。

- 型差分:
`jsonb`/`timestamptz` は SQLite では `TEXT` として保持している。移行時は型変換とUTC正規化が必要。
- UPSERT/制約差分:
SQLite の `ON CONFLICT` 書き方を PostgreSQL 方言へ置換する必要がある。
- インデックス差分:
SQLite で作成している運用インデックス（例: `chain_unmatched_events(chain_id, token_contract, created_at)`）を PostgreSQL でも再定義する。
- TTL運用差分:
`service_replay_guards` / `idempotency_records` は期限付き削除をアプリで実施している。
PostgreSQL移行時は `expires_at` index と定期ジョブ（例: cron/pg_cron）へ寄せると安全。
- マイグレーション差分:
現行は起動時 `schema_migrations` ベース。PostgreSQL移行時はトランザクションDDL前提で再検証する。

## 移行時の注意（SQLite -> PostgreSQL）

1. 先に PostgreSQL 側で制約・index を作成してからデータ投入する。
2. `REAL` 由来の金額列は `_base` を正として再計算検証する。
3. 監査チェーン (`audit_logs.prev_hash/entry_hash`) は移行時に過去hashを再計算せず、`audit_epochs.previous_tail_hash` で旧tailから新epochへbridgeしたうえで `verify-chain` を必須化する。
4. 切替期間は二重書きではなく read-only 期間を設け、差分検証ログを保存する。

## コアテーブル
### `stores`
- `id` (uuid, pk)
- `name` (text)
- `status` (active/suspended)
- `timezone` (text)
- `created_at`, `updated_at`

### `terminals`
- `id` (uuid, pk)
- `store_id` (fk -> stores.id)
- `terminal_code` (text, unique)
- `status` (active/lost/retired)
- `last_seen_at`
- `created_at`, `updated_at`

### `staff_users`
- `id` (uuid, pk)
- `store_id` (fk)
- `role` (staff/manager/admin)
- `status` (active/inactive)
- `created_at`, `updated_at`

### `terminal_sessions`
- `id` (uuid, pk)
- `terminal_id` (fk)
- `staff_user_id` (fk)
- `started_at`, `ended_at`
- `revoked_at`

### `invoices`
- `id` (uuid, pk)
- `invoice_no` (text, unique)
- `store_id` (fk)
- `terminal_id` (fk)
- `staff_user_id` (fk)
- `amount_jpy` (numeric)
- `amount_jpyc` (numeric)
- `chain_id` (text)
- `token_contract` (text)
- `recipient_address` (text)
- `payment_url` (text)
- `expires_at` (timestamptz)
- `status` (draft/issued/payment_detected/confirming/paid/expired/review_required/cancelled)
- `status_reason` (text, nullable)
- `created_at`, `updated_at`

### `payment_events`
- `id` (uuid, pk)
- `invoice_id` (fk)
- `event_type` (tx_detected/tx_confirmed/tx_reorg/tx_dropped/manual_adjustment)
- `chain_id` (text)
- `tx_hash` (text)
- `log_index` (int, nullable)
- `block_number` (bigint, nullable)
- `confirmations` (int, default 0)
- `from_address` (text)
- `to_address` (text)
- `token_contract` (text)
- `amount_jpyc` (numeric)
- `observed_at` (timestamptz)
- `raw_payload` (jsonb)
- `created_at`

### `review_cases`
- `id` (uuid, pk)
- `invoice_id` (fk)
- `reason_type` (shortage/overpay/duplicate/late_arrival/wrong_chain/wrong_token/other)
- `status` (open/in_progress/resolved/rejected)
- `assigned_to` (uuid, nullable)
- `resolution_note` (text, nullable)
- `created_at`, `updated_at`, `resolved_at`

### `refund_requests`
- `id` (uuid, pk)
- `review_case_id` (fk)
- `invoice_id` (fk)
- `requested_by` (uuid)
- `approved_by` (uuid, nullable)
- `status` (requested/approved/executing/succeeded/failed/cancelled)
- `refund_amount_jpyc` (numeric)
- `refund_to_address` (text)
- `refund_chain_id` (text)
- `refund_tx_hash` (text, nullable)
- `failure_reason` (text, nullable)
- `created_at`, `updated_at`

### `audit_logs`
- `id` (uuid, pk)
- `store_id` (text, nullable; 新規行はhash対象、旧行の後付け帰属は別表)
- `audit_epoch` (text, nullable; epoch-aware新規行は必須)
- `actor_type` (system/staff/admin/service)
- `actor_id` (text)
- `action` (text)
- `target_type` (invoice/review/refund/session/settings)
- `target_id` (text)
- `request_id` (text)
- `idempotency_key` (text, nullable)
- `before` (jsonb, nullable)
- `after` (jsonb, nullable)
- `ip_address` (text, nullable)
- `created_at`

### `audit_epochs`
- `id` (uuid, pk)
- `start_rowid`, `hash_version`
- `previous_epoch_id`, `previous_tail_hash`
- `reason`, `attestation_hash`, `created_at`
- UPDATE/DELETE禁止triggerで不変。旧epochの `audit_logs` は書き換えない。

### `audit_log_store_attributions`
- 旧 `audit_logs` 行の店舗帰属を、元 `entry_hash` に紐づく不変アテステーションとして保存する。
- 旧行の `store_id` / `prev_hash` / `entry_hash` は更新しない。

## 一意制約・インデックス
- `invoices.invoice_no` unique
- `payment_events` unique `(chain_id, tx_hash, coalesce(log_index, -1), event_type)`
- `refund_requests.refund_tx_hash` unique where not null
- `audit_logs` index `(target_type, target_id, created_at)`
- `invoices` index `(store_id, status, created_at)`

## 監査・保存方針（ドラフト）
- `audit_logs` は論理削除しない。
- 既存 `audit_logs` をrechainしない。hash仕様変更は必ず新epochと旧tail attestationで表現する。
- `payment_events.raw_payload` は最小限マスキングを実施。
- 保存期間は法務回答で確定（`open-questions` Q-009）。

## Done when
- 請求、支払い、レビュー、返金、監査が正規化される。
- 二重計上防止の一意制約が定義される。

## Output format
- テーブル定義は現行 SQLite 実装に追随する schema snapshot として保守する。
- 実装との差分が出た場合は本書とコードを同じ change で更新する。

## Validation method
- `docs/33-state-machine.md` の状態と一致する。
- `docs/34-idempotency-and-audit.md` の制約要件を満たす。

## Failure-handling behavior
- スキーマが状態遷移を表現できない場合、Phase 3を `FAIL` とし再設計する。
# 31. DB Schema

## Terminal Fixed QR Additions
- `terminals.public_entry_token`
  - terminal 固定 QR の公開用 opaque token。
  - `terminal_code` を外部へ出さずに固定入口 URL (`/t/:publicEntryToken`) を構成する。
- `terminals.current_invoice_id`
  - その terminal で現在お客様へ提示してよい active invoice の durable pointer。
- `terminals.current_invoice_assigned_at`
  - current invoice pointer を最後にセットまたは swap した時刻。

## Invariants
- `invoice` が取引の正本であり、fixed QR はその入口にすぎない。
- `current_invoice_id` が指してよいのは `issued` / `payment_detected` / `confirming` のみ。
- `paid` / `review_required` / `manual_review` / `expired` / `cancelled` / `settled` は current invoice に含めない。
- `receive_addresses.allocated_invoice_id` により、受取アドレスの trace は引き続き invoice 単位で保つ。
