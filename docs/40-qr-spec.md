# 40. QR Spec

## Goal
店頭端末で提示する QR の役割を `端末ごとの固定入口` に限定し、取引の正本を常に `invoice` に維持する。

## Fixed QR Entry
- 店頭で見せる主QRは `terminal` 固有の公開入口 URL (`/t/:publicEntryToken`) とする。
- fixed QR に埋め込む origin は final public URL `https://pay.miyamibu.xyz` に固定し、temporary host や内部検証用 URL をそのまま印刷しない。
- `publicEntryToken` は `terminal_code` そのものではなく、公開用の opaque token を使う。
- 固定QRは「入口」であり、会計の正本ではない。
- 固定QRを読んだ時点で `terminal.current_invoice_id` を参照し、active invoice が 1 件だけ存在する場合に限ってその invoice の signed `/pay?ref=...` へ解決する。
- ただし current invoice で provider/tap rail が `presented` 以降に入っている間は、fixed QR entry は wallet pay URL に解決せず、店頭案内中メッセージへ留まる。
- active invoice が存在しない場合は会計準備中ページを表示し、current invoice が立った時点で一度だけ signed invoice URL に遷移する。
- 一度 signed invoice URL に解決した顧客画面は、その後 terminal の current invoice が変わっても追従しない。

## Invoice-bound Payment URL
- invoice ごとの支払い導線は引き続き signed `/pay?ref=...` を使う。
- 必須: `invoiceId`, `exp`, `nonce`, `sig`
- 署名: `HMAC-SHA256(APP_SECRET, invoiceId.exp.nonce)`
- これが支払いページを `invoice` に固定する境界になる。

## Current Invoice Pointer
- `terminals.current_invoice_id` は `その端末で今お客様に見せてよい active invoice` を表す durable pointer である。
- active invoice の対象 status は `issued` / `payment_detected` / `confirming`。
- `paid` / `review_required` / `manual_review` / `expired` / `cancelled` / `settled` は current invoice に含めない。
- pointer の set / clear / swap は audit log に残す。
- pointer が stale な場合は、invoice 側の状態を優先して整合を回復する。

## Receive Address Policy
- `1 invoice = 1 receive_address` を原則とする。
- receive address pool が構成されている場合、invoice 発行時に `status=available` の address を 1 件だけ `allocated` に遷移させる。
- 同一 store / network / token で `issued|payment_detected|confirming` または未解決 `review_required` を持つ `receive_address` は再利用しない。
- QR 再発行は `new invoice + new signed pay URL + new receive_address` を必須とする。
- 旧 QR への後着金は旧 invoice 側で継続監視し、`late_arrival -> review_required` として扱う。
- address pool が枯渇した場合は `ADDRESS_POOL_EXHAUSTED` で invoice 発行を止める。

## Terminal Invariant
- `1 terminal = 同時に 1 件の active invoice` をサーバ側で強制する。
- 同一 terminal に active invoice が残っている状態で `POST /api/v1/invoices` は `TERMINAL_ACTIVE_INVOICE_EXISTS` を返す。
- 単一の固定受取アドレスしかない環境では、複数 terminal 並列会計を危険な推測突合で通さない。受取アドレス側の active lock が残る限り `ADDRESS_POOL_EXHAUSTED` で止める。
- same invoice で QR rail と tap rail を同時に顧客向けに開かない。
- tap rail から QR へ戻す場合は、staff の明示操作と audit evidence を必須にする。

## Constraints
- `sig` 不一致は即時 401。
- `exp` 期限超過は無効。
- `nonce` は 24 hex 固定。
- QR内容に秘密値を入れない。
- final public URL が確定する前に fixed QR を本印刷しない。
- receive address pool 利用時に単一 `RECIPIENT_ADDRESS` 集約へフォールバックしない。
- fixed QR のために同じ invoice を次会計へ再利用しない。
- fixed QR のために amount / payment_url / recipient_address を上書きしない。

## Validation
- `scripts/smoke-test.mjs` で署名不正ケースを確認。
- `public/invoices` 読み出しで `sig+exp+nonce` 必須を確認。
- `tests/fixed-terminal-qr.test.mjs` で fixed QR waiting / resolve / terminal invariant / reissue pointer swap を固定する。
- `tests/address-pool-sse.test.mjs` と `tests/security-hardening.test.mjs` で address allocation / reissue / old QR late arrival / pool exhaustion を固定する。

## Done when
- 店頭で見せる QR は terminal 固定入口を使う。
- 支払いページは invoice ごとの signed URL に固定される。
- 署名不正/期限切れが確実に拒否される。
