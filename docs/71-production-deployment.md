# 71. Production Deployment

## Goal
限定店舗の実証リリースに向けて、同じ構成を再現できる deployment pack を固定する。

## Deployment pack
- [Dockerfile](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/Dockerfile)
- [docker-compose.prod.yml](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docker-compose.prod.yml)
- [systemd service](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/systemd/jpyc-payment-terminal.service)
- [nginx config](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/nginx/jpyc-payment-terminal.conf)
- [Caddy template](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/caddy/Caddyfile.example)
- [Cloudflare Tunnel template](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/cloudflared/config.example.yml)
- [preflight](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/deploy/preflight.sh)
- [PC hosting preflight](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/deploy/preflight-pc-hosting.sh)
- [healthcheck](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/deploy/healthcheck.sh)
- [public host check](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/deploy/check-public-host.sh)
- [PC + domain hosting runbook](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/pc-domain-hosting-runbook.md)

## Runtime topology
- `app`: `src/server.mjs`
- `worker`: `src/chain-monitor.mjs`
- `nginx`: TLS終端と reverse proxy
- `caddy`: PC直公開時の TLS終端と reverse proxy
- `cloudflared`: 直公開できない場合の tunnel agent
- 永続領域: `./runtime`
  - `./runtime/data/app.db`
  - `./runtime/worker-state/chain-137.db`（worker operational state）
  - `./runtime/backups/`
  - `./runtime/logs/`

`DB_PATH` と `WORKER_STATE_DB_PATH` は同じ SQLite ファイルを指してはいけない。app は `runtime/data` を read/write、worker state を read-only でマウントし、worker は `runtime/worker-state` だけを read/write でマウントする。worker は financial tables を直接開かず、候補/evidence の signed internal read API と、既存の signed financial write API を使う。

## Environment files
- repo には [`.env.production.example`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/.env.production.example) のみ置く。
- 実運用では `.env.production` を別途配置し、秘密値を注入する。
- `APP_ENV=production`、`APP_HOST=https://pay.miyamibu.xyz`、`PAY_BASE_URL=https://pay.miyamibu.xyz`、`PUBLIC_BASE_URL=https://pay.miyamibu.xyz`、`CORS_ALLOW_ORIGINS=https://pay.miyamibu.xyz`、`DB_PATH=./runtime/data/app.db`、`WORKER_STATE_DB_PATH=./runtime/worker-state/chain-137.db` を基本形とする。

## Public URL policy
- final public URL は早い段階で `https://pay.miyamibu.xyz` に固定する。
- apex の `miyamibu.xyz` は、決済導線の origin にはせず `https://pay.miyamibu.xyz` へ redirect する。
- fixed QR は入口だけなので、内部検証用の一時 URL を印刷物にしない。
- fixed QR を作るのは `APP_HOST` / `PAY_BASE_URL` / `PUBLIC_BASE_URL` が final origin に揃い、公開確認が終わってからにする。

## Deployment modes
### Reference pack: Docker + nginx
- 既存の Docker/nginx pack は、再現性の高い基準構成として維持する。
- VPS や Linux host 上で標準化が必要な時はこの pack を使う。

### Mainline: always-on PC + Caddy
- 対象: `80/443` を直公開でき、ルーターのポートフォワードと DNS を扱える環境。
- 経路: `pay.miyamibu.xyz -> Caddy -> localhost:${APP_PORT:-4173} -> app`
- HTTPS は Caddy の自動証明書取得を使い、証明書費用は不要。
- worker はローカルで app と同じ PC 上に常駐させる。

### Fallback: always-on PC + Cloudflare Tunnel
- 対象: `CGNAT` や回線制約で 80/443 直公開が難しい環境。
- 経路: `pay.miyamibu.xyz -> Cloudflare DNS / Tunnel hostname -> cloudflared -> localhost:${APP_PORT:-4173} -> app`
- final public URL は direct mode と同じ `https://pay.miyamibu.xyz` に揃える。
- `cloudflared` の token / credentials は app env とは分離して保管する。

## Internal testing vs limited release
- `内部検証`: temporary URL や仮POPで動作確認してよいが、fixed QR の本印刷はしない。
- `限定実証`: `https://pay.miyamibu.xyz` が確定し、`/healthz` `/readyz` `/t/<public_entry_token>` `/pay?...` まで確認できてから customer-facing QR を出す。

## Install steps
1. リポジトリを `/opt/jpyc-payment-terminal` に配置する。
2. `.env.production` を配置する。
3. `mkdir -p runtime/data runtime/worker-state runtime/backups runtime/logs deploy/nginx/certs` を実行する。
4. `bash scripts/deploy/preflight.sh .env.production` を実行する。
5. `docker compose -f docker-compose.prod.yml up -d --build` を実行する。
6. `bash scripts/deploy/healthcheck.sh https://pay.miyamibu.xyz/healthz` を実行する。

## PC hosting steps
1. 独自ドメイン `miyamibu.xyz` を取得し、final public URL を `https://pay.miyamibu.xyz` に決める。
2. `.env.production` の `APP_HOST` / `PAY_BASE_URL` / `PUBLIC_BASE_URL` / `CORS_ALLOW_ORIGINS` を同じ `https://pay.miyamibu.xyz` に揃える。
3. `bash scripts/deploy/preflight.sh .env.production`
4. `bash scripts/deploy/preflight-pc-hosting.sh .env.production direct` または `bash scripts/deploy/preflight-pc-hosting.sh .env.production tunnel`
5. app と worker を同じ PC 上で起動する。
6. 直公開できる場合は [Caddy template](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/caddy/Caddyfile.example) を `pay.miyamibu.xyz` に合わせて配置する。
7. 直公開できない場合は [Cloudflare Tunnel template](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/cloudflared/config.example.yml) を `pay.miyamibu.xyz` に合わせて配置する。
8. 公開後は `bash scripts/deploy/check-public-host.sh .env.production <public_entry_token> '<signed_pay_url>'` で確認する。

## systemd install
1. [jpyc-payment-terminal.service](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/systemd/jpyc-payment-terminal.service) を `/etc/systemd/system/` へ配置する。
2. `WorkingDirectory` を実配置先に合わせて修正する。
3. `sudo systemctl daemon-reload`
4. `sudo systemctl enable --now jpyc-payment-terminal.service`
5. `journalctl -u jpyc-payment-terminal.service -f`

## TLS
- nginx は `deploy/nginx/certs/fullchain.pem` と `deploy/nginx/certs/privkey.pem` を参照する。
- 証明書は repo に含めない。
- 証明書未配置時は nginx が起動しないため、preflight後に証明書配置を確認する。
- Caddy 直公開時は public DNS と 80/443 到達性が揃えば、自動 HTTPS を前提にできる。
- Cloudflare Tunnel fallback 時は `pay.miyamibu.xyz` を tunnel hostname に向け、origin は `http://127.0.0.1:${APP_PORT:-4173}` のまま扱う。

## Verification
- `npm run deploy:check`
- `docker compose -f docker-compose.prod.yml config`
- `bash scripts/deploy/healthcheck.sh`
- `bash scripts/deploy/preflight-pc-hosting.sh .env.production direct`
- `bash scripts/deploy/preflight-pc-hosting.sh .env.production tunnel`
- `bash scripts/deploy/check-public-host.sh .env.production <public_entry_token> '<signed_pay_url>'`

## Done when
- 同じ手順で app / worker / nginx を再現できる。
- `.env.production` と runtime path を変えるだけで限定店舗実証環境を起動できる。
- `https://pay.miyamibu.xyz` を final public URL として Caddy 直公開と Cloudflare Tunnel fallback の両方を説明できる。
