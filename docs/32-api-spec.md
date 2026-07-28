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
- `Idempotency-Key` を要求する非同期更新APIは、業務処理開始前にキーを原子的にclaimする。
  - 同じactor / endpoint / key / payloadが処理中の場合は `409 IDEMPOTENCY_IN_PROGRESS` と `Retry-After: 1` を返し、重複処理へ入らない。
  - 同じキーでpayloadが異なる場合は従来どおり `409 IDEMPOTENCY_CONFLICT` とする。
  - 完了後の同じpayloadは、保存済みstatus/bodyをそのままreplayする。
  - 非同期ロジックが例外終了した場合も、同じキーで業務処理を自動再実行せず、保存した `500 INTERNAL_ERROR` をreplayしてfail-closedとする。

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

### `POST /api/v1/refunds/:refundId/verify`
- on-chain RPC確認はDB transaction外で行う。
- RPC完了後の短いimmediate transaction内で、開始時のrefund status / `updated_at` / tx hash / log indexが変わっていないことを再確認し、duplicate tx検査、条件付き更新、`refund.verified_onchain` 監査を一体で確定する。
- 別key/別actorの並行確認が先に同じ成功証跡を確定していた場合は、現行の成功結果を `200` で返し、監査ログを追加しない。
- 並行中に異なるtx証跡または状態へ変化していた場合は `409 REFUND_VERIFICATION_CONFLICT` とし、遅い側は状態更新も監査追加も行わない。

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

### `POST /api/v1/public/invoices/:invoiceId/consent`
- 役割: 顧客が同意した公開済み規約3点の版を、invoiceに紐づく監査証跡として記録する。
- 事前条件:
  - invoice固有の `sig` / `exp` / `nonce` が有効であること。
  - `public/mobile.js` の `POLICY_URLS` 3点がcredentialなしの公開HTTPS URLであること。
  - `POLICY_URLS` は単一ラベル名、`localhost` / `.local` / `.test` / `.invalid` / `.example` / `.arpa`、`example.com|org|net` とそのサブドメイン、およびIPv4/IPv6リテラルを許可しない。
  - `POLICY_VERSIONS` 3点が空でなく、`draft` / `pending` / `placeholder` / `example` を含まない公開版であること。
  - リクエストJSONは `terms_version` / `privacy_version` / `refund_policy_version` の3キーだけを含み、公開設定値と完全一致すること。
- 設定が未公開の場合は `503 POLICY_CONFIGURATION_NOT_READY`、送信キーまたは版が一致しない場合は `409 POLICY_VERSION_MISMATCH` を返す。どちらの場合も `customer_policy_consent` 監査ログは作成しない。
- 全条件を満たした場合だけ `200 { ok: true, recorded_at }` を返し、公開版3点と同意時刻を監査ログへ記録する。
- 公開エンドポイントの運用前検証（`scripts/deploy/healthcheck.sh` と `scripts/deploy/check-public-host.sh`）は、HTTPS/443以外を拒否し、全A/AAAA解決結果を検査して内部・予約・IPv4埋め込み・NAT64/6to4/Teredo等をfail-closedで拒否する。接続時は検査済みアドレスへlookupを固定し、同一originのHTTPSリダイレクトだけを許可する。`check-public-host.sh` は公開入口トークンと署名付き決済URLを必須とし、readyzのJSON内容も検証する。これは外部DNS・TLS・配信先が実際に公開されていることの代替ではなく、公開後に外部証跡として実行する。

### `POST /api/v1/public/invoices/:invoiceId/payment-recovery`
- 役割: 顧客が送金済みの `chain_id` と `tx_hash` を提出し、Ethereum / Avalanche の read-only recovery monitor に確認を依頼する。
- invoice固有の `sig` / `exp` / `nonce` が必要で、ウォレット送金・返金・資産移動は実行しない。
- `chain_id` は `1` または `43114` に限定する。RPCが未設定、receipt未取得、またはTransferを安全に判定できない場合は `unverified_report` または `customer_reported_wrong_chain|customer_reported_wrong_token` として保存し、「自動検知済み」と表示しない。
- 承認済みJPYCを請求先へ送ったことをRPC証跡で確認できた場合だけ、請求チェーンとの不一致を `verified_wrong_chain`、同一チェーンで別ERC-20を請求先へ送った場合を `verified_wrong_token` とする。
- レスポンスの `verification.rpc_verified` / `receipt_found` / `canonical_status` / `confirmations` は確認強度を示す。未検証の申告を支払い完了へ遷移させない。

### `POST /api/v1/payment-recovery/reports`
- 役割: 端末スタッフが invoice に紐づく同じ read-only recovery report を登録する。
- `invoice.read` と端末セッションを要求する。保存先は `payment_recovery_reports` と監査ログであり、invoiceの支払い状態を直接変更しない。

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

## Chain worker internal API

次の endpoint は公開APIではなく、`SERVICE_INGEST_SECRET` による signed service request（timestamp + jti + payload hash）専用である。worker は financial DB を直接開かず、候補/evidence の読み取りと financial write をこのAPI境界で行う。

### `POST /api/v1/internal/chain/candidates:read`
- worker が監視対象 invoice の候補を取得する read-only endpoint。
- request: `{ "chain_id": "137", "token_contract": "0x..." }`
- response: `schema_version`、`chain_id`、`token_contract`、`invoices[]`。
- chain/token が app の承認済み設定と一致しない場合は拒否する。

### `POST /api/v1/internal/chain/payment-evidence:read`
- worker が reorg/canonicality 再検証に必要な payment event evidence を取得する read-only endpoint。
- request: `{ "chain_id": "137", "from_block": 1, "to_block": 12 }`。block range は上限付き。
- response: `schema_version`、block range、`events[]`（invoice id、block/tx/log identity、block hash）。

### Existing signed financial writes
- `POST /api/v1/internal/payments/events:ingest`
- `POST /api/v1/internal/chain/reorgs:ingest`
- `POST /api/v1/internal/chain/reconciliation:ingest`

上記 write endpoint の署名検証・idempotency・監査記録は既存契約を維持する。read endpoint は financial table を更新せず、write endpoint だけが financial state transition を確定する。

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

## Public payment evidence timestamps

`GET /api/v1/public/invoices/:invoiceId` は、支払い証跡の時刻を次のように分離して返す。

- `confirmed_at`: 必要確認数を満たし、請求の `paid_tx_hash` と一致した `payment_events` をサーバー台帳へ記録した時刻（`payment_events.created_at`）。画面の「サーバーで確認済み」「支払い確認日時」はこの値を使う。
- `chain_recorded_at`: 同じ支払いイベントがブロックへ記録された時刻（`payment_events.block_timestamp`）。オンチェーン時刻であり、サーバー確認時刻とは扱わない。
- 支払いが未確定、対応する確定イベントがない、または各時刻が不正な場合、該当フィールドは `null` とする。
- 外部入力の `observed_at` はサーバー確認時刻の根拠には使わない。

## Validation
- `tests/server-integration.test.mjs` が public invoice API のレスポンス項目と EIP-681 payload を検証する
- `tests/backend-p0-safety.test.mjs` が `confirmed_at` と `chain_recorded_at` の意味を分離して検証する
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
  - current invoice の有無やrail状態にかかわらず、常に`/terminal-entry.html?token=...`へredirectする。
  - 利用者は入口画面で店舗・金額・会計番号を確認し、明示ボタンを押した場合のみinvoice固有のsigned `/pay?ref=...`へ進む。
- `GET /api/v1/public/terminal-entry/:publicEntryToken`
  - fixed QR waiting page が poll する公開 API。
  - `status=waiting|ready|blocked|tap_presented` を返す。
  - `ready` の場合はinvoice固有`pay_url`を返す。入口画面は自動redirectせず、遷移直前に最新状態と会計内容を再照合する。

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

## Customer Policy Publication

- `PATCH /api/v1/admin/stores/:storeId/customer-policies` はURL・公開version・SHA-256 hashに加え、`contents.terms` / `contents.privacy` / `contents.refund` の公開本文を必須とする。
- サーバーは本文を正規化せず、受信したUTF-8実バイトのSHA-256 (`sha256_utf8_exact_bytes_v1`) を計算する。改行コードやUnicode表現が異なれば別hashとする。
- 申告hashとサーバー計算hashが1つでも不一致、または本文不足の場合は `400 POLICY_PUBLICATION_INVALID` とし、store設定や同意証跡を更新しない。
- invoiceのpolicy snapshotには本文ではなく、サーバー計算hashとcanonicalization証跡を保存する。
- 発行時 `policy_snapshot_json` を持たないinvoiceは、後日のstore policyへfallbackしない。公開invoice APIはpolicyを `null` とし、同意APIは `snapshot_missing: true` でfail-closedにする。

## Human Accounting Adjustment endpoints
- `POST /api/v1/accounting-adjustments`
  - `accounting.adjustment.create` が必要。
  - `invoice_id`、`adjustment_type`（`manual_acceptance` / `loss_accepted` / `goodwill` / `write_off`）、正の`amount_jpyc_base`、10文字以上の`reason`、`evidence.evidence_ref`を必須とする。
  - 作成者のfresh step-upを要求し、`status=pending`で保存する。`review_case_id`を指定した場合は同一請求のレビューへ紐付ける。
- `POST /api/v1/accounting-adjustments/:id/approve`
  - `accounting.adjustment.approve`が必要。
  - 承認者のfresh step-upと作成者とは異なるactive staffを要求し、`status=approved`へ遷移する。
  - `accounting_event_journal`と監査ログへ証拠・理由・作成者・承認者・請求の支払い状態スナップショットを記録する。
- 上記の作成・承認とレビュー更新は`invoices.status`および`invoices.paid_tx_hash`を変更しない。`accepted_as_paid`で未払い請求を`paid`にする経路はない。
- 承認済みIDを指定した`PATCH /api/v1/reviews/:reviewId`の`disposition=accounting_adjustment`だけが、人手調整済みとしてレビュー処分を記録する。

## Settlement Export endpoints and versioning

- `POST /api/v1/settlement-exports` と新規の `POST /api/v1/settlements/daily:close` は `settlement_export_v2` snapshotを作成し、レスポンスで `contract_version` を明示する。
- `GET /api/v1/settlements/daily:export` と `GET /api/v1/settlements/monthly:export` は現行ledgerを読むlegacy operational exportであり、保存済みv1/v2 snapshotの代替やsource of truthとはしない。
  - review/refundとのjoinで同一invoiceが複数行になる場合、detail行は保持しつつ決定的に1行だけを `invoice_primary` とし、その他を `invoice_detail_only` とする。
  - invoice件数とinvoice単位の金額集計にはprimary行だけを使い、join倍増による二重計上を認めない。
  - 返金件数は `refund_request_id` ごとに決定的な `refund_primary` 行を1行だけ使い、review等とのjoinで同一refundを重複集計しない。
  - JSONはjoin証跡の `rows`、invoice単位の `invoice_rows`、`refund_request_id` 単位の `refund_rows` を分離する。CSVは1 invoice=1行のまま、全refund参照を `legacy_refund_references_json` に決定順で格納し、代表refund以外の証跡を落とさない。
- `GET /api/v1/settlement-exports/:id` は保存時の契約版を読み、`contract_version` を返す。保存済みv1を読取時にv2へ合成しない。
- `GET /api/v1/settlement-exports/:id/download` は保存時の契約版でserialiseし、`x-settlement-export-contract-version` を返す。
  - v1は既存JSON形状とBOM付きCSV header/bytesを維持する。
  - v2は `refund_manifest` / `refund_totals` と行の `refund_attribution` を含み、保存済みcanonical JSON/CSV hashと一致しない場合は `409 SETTLEMENT_EXPORT_HASH_MISMATCH` とする。
- v2の返金はinvoice単位で一度だけmanifest集計し、決定的に選んだprimary payment-session行だけを `invoice_primary` として金額・参照を帰属する。兄弟行は `invoice_manifest_only` とし、返金額を重複計上しない。
- 同一 `created_at` の行順はinvoice / payment-session / rail / provider / row idで決定し、同じsnapshotの再downloadは同じbytes/hashを返す。
- 不正な返金基準額は黙って0にせず、返金作成・settlement export・daily closeを `409 REFUND_LEDGER_INTEGRITY_ERROR` で停止する。
- 過去のsettlementに紐づくexportがない場合、repeat closeは別exportを推測せず `export_binding_status: "legacy_export_missing"`、`export_id: null`、`contract_version: null` を返す。
- v1の契約は `docs/contracts/settlement-export-v1.md`、v2は `docs/contracts/settlement-export-v2.md` と対応schemaをsource of truthとする。
