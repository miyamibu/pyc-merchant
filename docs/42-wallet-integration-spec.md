# 42. Wallet Integration Spec

## Goal
公開決済ページから利用者ウォレットの送金画面を、根拠のある標準URIと設定可能な deeplink template で起動できるようにする。

## Context
- 実装: [`src/wallet-adapter.mjs`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/src/wallet-adapter.mjs)
- 公開ページ: [`public/mobile.js`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/public/mobile.js)
- 公開請求API: [`src/server.mjs`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/src/server.mjs)

## Constraints
- アプリは秘密鍵を保持しない。
- 送金署名は利用者ウォレット側で行う。
- 根拠不明の wallet deeplink をハードコードしない。
- 初期スコープは Polygon 上の JPYC のみ。

## Adapter interface
- `createWalletAdapter(env)` が返す項目:
  - `available`
  - `status`
  - `reason`
  - `wallet_help_url`
  - `reown_project_id_configured`
  - `wallet_deeplink_template_configured`

## Wallet launch payload
- `buildWalletLaunchPayload(...)` が生成する項目:
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
  - `amount_jpy`
  - `expires_at`
  - `pay_url`
  - `copy_fallback`

## URI policy
- 標準起動URIは EIP-681 を使う
- 形式:

```text
ethereum:<TOKEN_CONTRACT>@137/transfer?address=<RECEIVE_ADDRESS>&uint256=<EXPECTED_AMOUNT_ATOMIC>
```

- `expected_amount_atomic` は token decimals ベースの整数文字列を使う
- 表示用 `amount_jpy` と送金用 atomic amount を混同しない

## Deeplink template policy
- 優先 env:
  - `HASHPORT_WALLET_DEEPLINK_TEMPLATE`
  - `WALLET_DEEPLINK_TEMPLATE`
- テンプレートでは以下の変数を展開できる:
  - `{{payment_uri}}`
  - `{{payment_uri_encoded}}`
  - `{{receive_address}}`
  - `{{receive_address_encoded}}`
  - `{{expected_amount_atomic}}`
  - `{{token_contract}}`
  - `{{token_contract_encoded}}`
  - `{{token_symbol}}`
  - `{{token_symbol_encoded}}`
  - `{{chain_id}}`
  - `{{network}}`
  - `{{network_encoded}}`
  - `{{pay_url}}`
  - `{{pay_url_encoded}}`
- 承認テンプレートは、送金値を意味の対応する query parameter の値全体へ1対1で結び付ける。fragment、重複parameter、固定値または未結合のquery parameterは許可しない
- `payment_uri` をラップする場合は `{{payment_uri_encoded}}` を使用し、承認済みの `uri` / `payment_uri` / `request` parameterへ結び付ける
- 起動直前に、実際の請求で展開した query parameter と `payment_uri` / 受取アドレス / atomic amount / chain ID / token contract を完全一致で再検証する。検証できない場合はdeeplinkを返さずcopy fallbackへ退避する

## Public page launch order
`public/mobile.js` の「ウォレットで支払う」ボタンは次の順で起動を試みる。

1. `wallet_deeplink`
2. `payment_uri`
3. `wallet_url`
4. manual payment UI と copy fallback

どれも使えない場合でも、受取アドレス、送金額、ネットワーク、トークンを表示して手動支払いを継続できる。

## Runtime modes
- `mock`: 開発・テスト用
- `reown`: 実セッション／AppKit統合が未実装のため、設定値だけでは `ready` にしない
- 利用不可の場合も公開APIは `reason` と copy fallback を返す

## Validation
- `tests/wallet-adapter.test.mjs`
- `tests/server-integration.test.mjs`
- `tests/frontend-security.test.mjs`
- `scripts/production-validation/validate-wallet-launch.mjs`

## Done when
- 公開請求APIが wallet launch payload を一貫して返す。
- 標準URIと設定可能 deeplink の二段構えになっている。
- 実機未検証項目は証跡計画へ切り出されている。
