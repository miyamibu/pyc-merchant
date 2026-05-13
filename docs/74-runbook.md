# 74. Runbook

## Goal
開店前/閉店後/障害時の実行手順を統一する。

## 開店前
1. `Authorization: Bearer ${METRICS_SECRET}` を付けて `/readyz` を確認し、`approvals` の各フラグが運用意図どおりであることを確認する。
2. `payments_disabled=false` にする前に address pool 在庫があることを確認する。
3. 当日 `daily-status` が未締めであることを確認する。
4. `chain-monitor/status` で `pending_dead_letter_count=0` / `abandoned_dead_letter_count=0` を確認する。
5. 端末ログインと invoice 発行を行い、SSE 更新が受信できることを確認する。

## 営業中
- `review_required` は即レビュー着手
- wrong chain/token は顧客へ再送案内
- tx pending は二重送信抑止

## プロトタイプのデモモード運用
- `index.html` の開発用デモ操作は次の条件をすべて満たす時のみ表示される。
  - URLクエリ `demo=1`
  - `APP_ENV != production`
  - `DEMO_CONTROLS_ENABLED=true`
- production では `DEMO_CONTROLS_ENABLED=true` で起動できない。
- 本番運用では `index.html` のデモ操作を使わず、`/terminal.html` と `/mobile.html` で確認する。

## receive address pool 運用
### Import
```bash
curl -sS -X POST "http://127.0.0.1:4173/api/v1/admin/receive-addresses:import" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: address-import-20260420-001" \
  -d '{
    "source_label": "merchant_batch_20260420",
    "addresses": [
      "0x1000000000000000000000000000000000000001",
      "0x1000000000000000000000000000000000000002"
    ]
  }'
```

### Disable
```bash
curl -sS -X POST "http://127.0.0.1:4173/api/v1/admin/receive-addresses/<ADDRESS_ID>/disable" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: address-disable-20260420-001" \
  -d '{"reason":"ops_disable"}'
```

private key や mnemonic らしき値を含む import は拒否され、監査ログに残る。

## verified manual ingest
1. invoice と tx hash を確認する。
2. `POST /api/v1/payments/events:ingest` へ tx hash を送る。
3. サーバーが receipt / block / ERC-20 Transfer を RPC で検証する。
4. exact match は通常の支払い判定へ進む。
5. late / overpay / shortage / wrong recipient は review に送られる。

```bash
curl -sS -X POST "http://127.0.0.1:4173/api/v1/payments/events:ingest" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: manual-ingest-20260420-001" \
  -d '{
    "invoice_id": "<INVOICE_ID>",
    "tx_hash": "<TX_HASH>"
  }'
```

## refund verification
1. refund request を承認・実行し、`recorded` または `pending_verification` にする。
2. 実行済み tx hash を確認する。
3. `POST /api/v1/refunds/:refundId/verify` で on-chain verification を行う。
4. 完全一致時のみ `succeeded` に昇格する。

```bash
curl -sS -X POST "http://127.0.0.1:4173/api/v1/refunds/<REFUND_ID>/verify" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: <IDEMPOTENCY_KEY>" \
  -d '{
    "refund_tx_hash": "<REFUND_TX_HASH>"
  }'
```

## 閉店後
1. `POST /api/v1/settlements/daily:close`
2. 監査ログ export
3. レビュー未解決件数を引継ぎ

## 障害時
- docs/73 に沿って記録→切替→復旧の順で実施。
- インシデント判定時は最優先で kill switch を実行し、新規請求を停止する。

## インシデント時 kill switch 手順
1. **停止** `POST /api/v1/admin/payments/disable`（理由必須推奨）
2. 必要に応じて **店舗停止** `POST /api/v1/admin/stores/:storeId/payments/disable`
3. 必要に応じて **端末停止** `POST /api/v1/admin/terminals/:terminalId/payments/disable`
4. 請求作成APIが `503 PAYMENTS_DISABLED` を返し、`details.global_disabled | store_disabled | terminal_disabled` のどれで止まっているか確認
5. 既着金は chain-monitor ingest 継続、`review_required` で処理
6. 原因調査・影響評価・レビュー残件確認
7. **再開** `POST /api/v1/admin/payments/enable` または scope 別 enable
8. 監査ログで `payments.disabled|enabled`, `payments.store_disabled|enabled`, `payments.terminal_disabled|enabled` が記録されたことを確認

## API実行例（curl）

### 1) 端末ログイン

```bash
curl -sS -X POST "http://127.0.0.1:4173/api/v1/terminal-sessions" \
  -H "content-type: application/json" \
  -H "x-request-id: runbook-login-001" \
  -d '{
    "terminalCode": "TERM-001",
    "staffPin": "1234"
  }'
```

### 2) 請求作成（Idempotency-Key必須）

```bash
curl -sS -X POST "http://127.0.0.1:4173/api/v1/invoices" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: runbook-invoice-001" \
  -d '{
    "amount_jpy": 1000
  }'
```

レスポンスには invoice ごとの `receive_address` と `sse.token` が含まれる。端末 UI は必要に応じて `POST /api/v1/invoices/:invoiceId/sse-token` で短命 token を再発行する。

### 3) 請求状態確認

```bash
curl -sS "http://127.0.0.1:4173/api/v1/invoices/<INVOICE_ID>" \
  -H "authorization: Bearer <SESSION_TOKEN>"
```

### 4) 日次締め

```bash
curl -sS -X POST "http://127.0.0.1:4173/api/v1/settlements/daily:close" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: runbook-settlement-2026-04-20" \
  -d '{
    "business_date": "2026-04-20"
  }'
```

### 5) 監査ログexport（打ち切り警告ヘッダ確認）

```bash
curl -i -sS "http://127.0.0.1:4173/api/v1/audit-logs/export?format=json&limit=5000" \
  -H "authorization: Bearer <SESSION_TOKEN>"
```

`X-Audit-Export-Warning` が返る場合は、件数が上限で打ち切られているため分割取得する。

### 6) メトリクス確認

```bash
# Prometheus text format
curl -sS "http://127.0.0.1:4173/metrics" \
  -H "authorization: Bearer ${METRICS_SECRET}"

# JSON互換（運用UI向け）
curl -sS "http://127.0.0.1:4173/metrics?format=json" \
  -H "authorization: Bearer ${METRICS_SECRET}"

# readiness
curl -sS "http://127.0.0.1:4173/readyz" \
  -H "authorization: Bearer ${METRICS_SECRET}"
```

`/readyz` の `approvals` で legal / AML / privacy / APPI と approval ref の状態を確認する。

### 7) 新規請求の停止/再開（kill switch）

```bash
# 停止
curl -sS -X POST "http://127.0.0.1:4173/api/v1/admin/payments/disable" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: runbook-disable-001" \
  -d '{"reason":"incident_response"}'

# 再開
curl -sS -X POST "http://127.0.0.1:4173/api/v1/admin/payments/enable" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: runbook-enable-001" \
  -d '{"reason":"incident_resolved"}'
```

```bash
# 店舗単位停止
curl -sS -X POST "http://127.0.0.1:4173/api/v1/admin/stores/<STORE_ID>/payments/disable" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: runbook-store-disable-001" \
  -d '{"reason":"store_specific_incident"}'

# 端末単位停止
curl -sS -X POST "http://127.0.0.1:4173/api/v1/admin/terminals/<TERMINAL_ID>/payments/disable" \
  -H "authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -H "idempotency-key: runbook-terminal-disable-001" \
  -d '{"reason":"terminal_specific_incident"}'
```

## Done when
- 店舗運用担当がDB直接操作なしで回せる。
- address pool / verified manual ingest / refund verification / global+scoped kill switch の各操作が監査ログ付きで実施できる。
