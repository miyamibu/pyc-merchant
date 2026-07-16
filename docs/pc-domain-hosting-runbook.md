# PC + Domain Hosting Runbook

## Goal
`独自ドメインだけ課金` + `つけっぱなしPCをサーバ` + `HTTPSは無料` の前提で、`https://pay.miyamibu.xyz` を final public URL に固定したまま QR 先行の限定実証へ進める。

## Context
- この repo は `Node 24.17.0 + SQLite + worker + SSE` 前提で、静的ホスティング向けではない。
- fixed QR は印刷物になるので、customer-facing URL は早めに固定する必要がある。
- 取引の正本は常に `invoice` であり、fixed QR は入口だけである。
- external account 操作は repo の外で行い、repo には手順・テンプレート・安全なローカル確認コマンドだけを置く。

## Constraints
- `APP_HOST` / `PAY_BASE_URL` / `PUBLIC_BASE_URL` は同じ `https://pay.miyamibu.xyz` に揃える。
- fixed QR は final public URL が確定するまで本印刷しない。
- `cloudflared` の token / credentials は app env に混ぜない。
- `Quick Tunnel` や `ngrok free` は内部検証用の temporary URL としてだけ扱い、外向け fixed QR には使わない。

## Buy
- 課金するもの:
  - 独自ドメイン 1 個
- 課金しないもの:
  - VPS
  - SSL 証明書
  - Caddy
  - Let's Encrypt
- まず決める値:
  - `miyamibu.xyz`
  - `pay.miyamibu.xyz`

## Configure
### 1. Final public URL を決める
- `pay.miyamibu.xyz` を customer-facing の固定URLにする。
- `.env.production` は次の3つを完全一致させる。
  - `APP_HOST=https://pay.miyamibu.xyz`
  - `PAY_BASE_URL=https://pay.miyamibu.xyz`
  - `PUBLIC_BASE_URL=https://pay.miyamibu.xyz`
- `CORS_ALLOW_ORIGINS=https://pay.miyamibu.xyz` を設定する。
- `miyamibu.xyz` の apex は、運用方式に応じて `https://pay.miyamibu.xyz` へ redirect する。

### 2. Internal testing と limited release を分ける
- `内部検証`:
  - temporary URL を使ってよい。
  - 仮POPや画面表示での確認に留める。
  - fixed QR は本印刷しない。
- `固定QRを外向けに出す段階`:
  - final public URL が `https://pay.miyamibu.xyz` に固定済み。
  - `https://pay.miyamibu.xyz/healthz`
  - `https://pay.miyamibu.xyz/readyz`
  - `https://pay.miyamibu.xyz/t/<public_entry_token>`
  - `https://pay.miyamibu.xyz/pay?...`
  - 上の4種類を確認してから fixed QR を作る。

### 3. 80/443 が直公開できるか確認する
- 外部でやること:
  - つけっぱなしPCの回線が `80/443` を受けられるか確認する。
  - ルーターのポートフォワードが設定できるか確認する。
  - ISP が `CGNAT` ではないか確認する。
- repo 側で使う確認:
  - `bash scripts/deploy/preflight-pc-hosting.sh .env.production direct`
  - この時点では direct mode 用の `caddy` コマンド存在確認までを行う。

### 4. 直公開できるなら Caddy
- 経路:
  - `pay.miyamibu.xyz -> Caddy -> http://127.0.0.1:4173`
- repo に入っているもの:
  - [deploy/caddy/Caddyfile.example](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/caddy/Caddyfile.example)
- 外部でやること:
  - DNS を `pay.miyamibu.xyz -> PCの公開IP` に向ける。
  - apex を使う場合は `miyamibu.xyz -> PCの公開IP` に向け、Caddy の redirect block を有効にする。
  - ルーターで 80/443 を PC に転送する。
  - Caddy をインストールし、Caddyfile を実配置する。
- 確認:
  - `bash scripts/deploy/check-public-host.sh .env.production <public_entry_token> '<signed_pay_url>'`

### 5. 直公開できないなら Cloudflare Tunnel fallback
- 経路:
  - `pay.miyamibu.xyz -> Cloudflare Tunnel hostname -> cloudflared -> http://127.0.0.1:4173`
- repo に入っているもの:
  - [deploy/cloudflared/config.example.yml](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/cloudflared/config.example.yml)
- 外部でやること:
  - Cloudflare account / zone を作る。
  - `pay.miyamibu.xyz` を tunnel hostname に向ける。
  - apex を使う場合は Cloudflare 側で `miyamibu.xyz` から `https://pay.miyamibu.xyz` への redirect rule を作る。
  - `CLOUDFLARE_TUNNEL_TOKEN` または tunnel credentials を cloudflared 側に設定する。
  - `cloudflared` をインストールし、config を実配置する。
- 確認:
  - `bash scripts/deploy/preflight-pc-hosting.sh .env.production tunnel`
  - `bash scripts/deploy/check-public-host.sh .env.production <public_entry_token> '<signed_pay_url>'`

## Check
### Codex が repo に実装したもの
- `deploy/caddy/Caddyfile.example`
- `deploy/cloudflared/config.example.yml`
- `scripts/deploy/preflight-pc-hosting.sh`
- `scripts/deploy/check-public-host.sh`
- README / deployment / operations / QR docs の導線整理
- `src/public-endpoint-security.mjs` による公開HTTPS検証（DNS解決先の固定、内部・予約IP拒否、TLS検証、同一ホスト以外のリダイレクト拒否）

`check-public-host.sh` は公開入口トークンと署名付き決済URLを必須引数として受け取り、この検証を通してから `readyz`、固定入口、署名付き決済URLを確認する。引数を省略した検査は成功扱いしない。DNSが未登録、証明書が不一致、または解決先が内部・予約IPの場合はfail-closedとなる。

### ユーザーが外部でやること
- 独自ドメインの購入
- DNS の本番変更
- Cloudflare account / tunnel 作成
- Caddy または cloudflared のインストール
- ルーター設定、ポート開放、CGNAT 確認
- final public URL 確定後の fixed QR 作成

## Official references
- Caddy automatic HTTPS: <https://caddyserver.com/docs/automatic-https>
- Let’s Encrypt getting started: <https://letsencrypt.org/getting-started/>
- Cloudflare Tunnel overview: <https://developers.cloudflare.com/tunnel/>
- Cloudflare Tunnel routing: <https://developers.cloudflare.com/tunnel/routing/>

## Done when
- `https://pay.miyamibu.xyz` が final public URL として `.env.production` に固定されている。
- direct / tunnel のどちらでも同じ `https://pay.miyamibu.xyz` に収束する。
- internal testing と limited release が混同されていない。
- fixed QR を作るタイミングが final public URL 確定後だと明示されている。
