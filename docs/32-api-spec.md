# 32. API Specification

## Goal
端末UI、公開決済ページ、運用手順が依存する API 契約を現行実装に合わせて整理する。

## Context
- アプリサーバーは `/api/v1` 配下に invoice、public invoice、review、refund、audit、settlement 関連 API を提供している。
- 公開請求APIはウォレット起動 payload と copy fallback を返し、利用者ウォレット側の送金実行を支援する。
- 詳細なレスポンス差分はテストで固定し、実機依存の完了判定は [`docs/90-production-validation-plan.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/90-production-validation-plan.md) に委ねる。

## Constraints
- non-custodial 方針を崩さない。
- 更新系 API では監査ログと状態遷移整合を壊さない。
- 公開 API に秘密情報を出さない。
- invoice ごとの pay payload は Polygon / JPYC に限定する。

## Common rules
- Base path: `/api/v1`
- Auth:
  - 端末・管理系: `Authorization: Bearer <session token>`
  - 監視系: `Authorization: Bearer <METRICS_SECRET>`
  - 公開決済ページ: 認証不要
- Response format: `application/json`
- Error format:

```json
{
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  }
}
```

## Core endpoints
### `POST /api/v1/invoices`
- 役割: invoice を作成し、端末UIへ pay payload を返す。
- 事前条件:
  - store / terminal scope で kill switch が無効
  - store / terminal status が `active`
  - address pool 構成時は `1 invoice = 1 receive_address`
- 主なレスポンス項目:
  - `invoice_id`
  - `status`
  - `amount_jpy`
  - `expires_at`
  - `pay_url`
  - `wallet_adapter`
  - `payment_uri`
  - `wallet_deeplink`
  - `wallet_url`
  - `wallet_help_url`
  - `supported_wallets`
  - `network`
  - `chain_id`
  - `token_symbol`
  - `token_contract`
  - `token_decimals`
  - `receive_address`
  - `expected_amount_atomic`
  - `copy_fallback`

### `GET /api/v1/invoices/:invoiceId`
- 役割: 管理画面や運用画面が invoice 現況と pay payload を再取得する。
- paid / review_required / expired でもレスポンス形状は極力維持する。
- `provider_summary` を含み、terminal UI はここから tap rail の operator state / QR suppress 状態 / fulfillment を再描画する。
- `customer_payment_mode` を含み、公開 invoice UI も同じ invoice に対して wallet 導線を抑止できる。

### `POST /api/v1/invoices/:invoiceId/provider-sessions:present`
- 役割: provider/tap rail を `決済実行` ではなく `提示開始(presented)` として開始する。
- 契約:
  - invoice は同一 terminal の current active invoice であること
  - invoice status は `issued` であること
  - 同じ invoice で QR rail と tap rail を同時に顧客向けに開かない
  - 成功時は `provider_summary.payment_session_status=presented` とし、fixed QR entry は wallet 導線を suppress する

### `POST /api/v1/invoices/:invoiceId/provider-sessions:cancel`
- 役割: tap rail の顧客案内を終了し、明示的に QR 案内へ戻す。
- 契約:
  - provider-side `failed/voided` と同義ではない
  - provider summary が QR resume 可能な時だけ成功する
  - 成功時は `provider_summary.qr_available=true`

### `POST /api/v1/invoices/:invoiceId/reissue`
- 役割: 期限切れ・再表示用に新 invoice を発行する。
- 契約:
  - 元 invoice が `paid` の場合は拒否する
  - 元 invoice が `issued|payment_detected|confirming` の場合、元 invoice は `expired` または `review_required` に遷移する
  - 新 invoice は元 `checkout_session_id` を引き継ぎつつ、`invoice_id` / `payment_url` / `receive_address` は必ず新規になる

### Scoped kill switch
- `POST /api/v1/admin/payments/disable|enable`
  - 全体停止 / 再開
- `POST /api/v1/admin/stores/:storeId/payments/disable|enable`
  - 店舗単位停止 / 再開
- `POST /api/v1/admin/terminals/:terminalId/payments/disable|enable`
  - 端末単位停止 / 再開
- 新規 invoice / reissue のみを止め、既存 invoice の照会・review・audit・reconcile は継続する。

### `GET /api/v1/public/invoices/:invoiceId`
- 役割: 公開決済ページが表示とウォレット起動に必要な情報を取得する。
- 主なレスポンス項目:
  - `invoice_id`
  - `status`
  - `amount_jpy`
  - `expires_at`
  - `payment_url`
  - `pay_url`
  - wallet payload 一式
- `copy_fallback` は `wallet_adapter.available=false` の場合でも返す。
- `customer_payment_mode` を返し、tap rail 提示中は wallet ボタンを無効化する。
- 署名なし・署名不正の直接参照は拒否する。
- rate limit 超過時は `429 RATE_LIMITED` を返す。

### `GET /healthz`
- 役割: liveness check。
- 用途: Docker HEALTHCHECK、reverse proxy upstream 監視、一次切り分け。

### `GET /readyz`
- 役割: readiness check。
- 用途: DB、必須 env、運用ゲートが揃っているかの簡易確認。
- 認証: `Authorization: Bearer <METRICS_SECRET>`

### `GET /metrics`
- 役割: runtime metrics / JSON diagnostics の取得。
- 用途: Prometheus scrape、運用ダッシュボード、`format=json` による一次切り分け。
- 認証: `Authorization: Bearer <METRICS_SECRET>`

## Wallet launch payload contract
公開請求APIと invoice API が返す wallet payload は次を基準にする。

```json
{
  "wallet_adapter": {
    "available": true,
    "status": "ready",
    "reason": null,
    "wallet_help_url": "https://...",
    "reown_project_id_configured": true,
    "wallet_deeplink_template_configured": false
  },
  "payment_uri": "ethereum:0xTOKEN@137/transfer?address=0xRECEIVE&uint256=123456",
  "wallet_deeplink": null,
  "wallet_url": "ethereum:0xTOKEN@137/transfer?address=0xRECEIVE&uint256=123456",
  "wallet_help_url": "https://...",
  "supported_wallets": ["HashPort Wallet", "WalletConnect"],
  "network": "Polygon",
  "chain_id": "137",
  "token_symbol": "JPYC",
  "token_contract": "0xTOKEN",
  "token_decimals": 18,
  "receive_address": "0xRECEIVE",
  "expected_amount_atomic": "123456",
  "amount_jpy": 1000,
  "expires_at": "2026-04-20T12:34:56.000Z",
  "pay_url": "https://pay.miyamibu.xyz/pay?ref=INV_...",
  "copy_fallback": {
    "copy_receive_address": "0xRECEIVE",
    "copy_amount": "123456",
    "copy_network": "Polygon",
    "copy_token": "JPYC"
  }
}
```

## Wallet URI rules
- `chain_id` は `137`
- `payment_uri` は EIP-681 形式を採用する
- 形式:

```text
ethereum:<TOKEN_CONTRACT>@137/transfer?address=<RECEIVE_ADDRESS>&uint256=<EXPECTED_AMOUNT_ATOMIC>
```

- `wallet_deeplink` は `HASHPORT_WALLET_DEEPLINK_TEMPLATE` または `WALLET_DEEPLINK_TEMPLATE` が設定されている場合のみ展開する
- テンプレート未設定時は `wallet_url` に `payment_uri` を返し、copy fallback を使えるようにする

## State expectations
- `issued`: 通常の pay payload を返す
- `paid`: 支払い完了表示用に pay payload は残すが、UI は状態を優先表示する
- `review_required`: copy fallback を維持しつつ、review 状態を表示する
- `expired`: 期限切れ案内と再発行導線を優先する

## Validation
- `tests/server-integration.test.mjs` が public invoice API のレスポンス項目と EIP-681 payload を検証する
- `tests/wallet-adapter.test.mjs` が URI 生成、deeplink template 展開、copy fallback を検証する
- `tests/frontend-security.test.mjs` が mobile UI の launch order と copy fallback の存在を検証する

## Done when
- invoice 系 API と公開請求APIのレスポンスが現行実装と一致している。
- wallet launch payload の責務が明確である。
- 外部依存の完了判定と API 契約が混同されていない。
# 32. API Spec

## Terminal Fixed QR Endpoints
- `GET /t/:publicEntryToken`
  - terminal 固定 QR の公開入口。
  - current invoice がある場合は、その invoice の signed `/pay?ref=...` へ redirect。
  - ただし current invoice で tap rail が提示中なら redirect せず、`/terminal-entry.html?token=...` へ留める。
  - current invoice がない場合は `/terminal-entry.html?token=...` へ redirect。
- `GET /api/v1/public/terminal-entry/:publicEntryToken`
  - fixed QR waiting page が poll する公開 API。
  - `status=waiting|ready|blocked|tap_presented` を返す。
  - `ready` の場合は invoice 固有 `pay_url` を返し、waiting page は一度だけ redirect する。

## Terminal Session Response
- `POST /api/v1/terminal-sessions`
  - `fixed_qr_url`
  - `public_entry_token`
  - `current_invoice`
  を返す。terminal UI はログイン後にこの情報で固定QR表示と current invoice の復元を行う。

## Invoice Creation Guard
- `POST /api/v1/invoices`
  - 同一 terminal に active invoice がある場合は `409 TERMINAL_ACTIVE_INVOICE_EXISTS`。
  - 単一受取アドレス環境などで recipient 側 lock が残っている場合は `409 ADDRESS_POOL_EXHAUSTED`。

## Reissue Behavior
- `POST /api/v1/invoices/:invoiceId/reissue`
  - 旧 invoice の lineage を維持しつつ、新しい invoice を作成する。
  - current invoice pointer は同一 transaction 内で新 invoice へ swap する。
