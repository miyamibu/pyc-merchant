# 73. Operations Runbook

## Goal
限定店舗実証の運用担当が、起動確認・一次切り分け・ログ採取・復旧判断を同じ手順で実施できるようにする。

## Daily start
1. `bash scripts/deploy/preflight.sh .env.production`
2. 配備方式に応じて次のどちらかを確認する。
   - Docker/nginx: `docker compose -f docker-compose.prod.yml ps`
   - PC hosting: `bash scripts/deploy/preflight-pc-hosting.sh .env.production <direct|tunnel>`
3. `bash scripts/deploy/healthcheck.sh https://pay.miyamibu.xyz/healthz`
4. `curl -sS https://pay.miyamibu.xyz/readyz -H "authorization: Bearer ${METRICS_SECRET}"`
5. receive address pool と `PAYMENTS_DISABLED` の状態を確認する。
6. customer-facing fixed QR を出す前に `bash scripts/deploy/check-public-host.sh .env.production <public_entry_token> '<signed_pay_url>'` を実行する。

## First response
- 症状: API応答なし
  - `docker compose -f docker-compose.prod.yml ps`
  - `docker compose -f docker-compose.prod.yml logs --no-color app`
- 症状: 着金更新が止まる
  - `docker compose -f docker-compose.prod.yml logs --no-color worker`
  - `/api/v1/chain-monitor/status`
- 症状: TLS/公開アクセス異常
  - `docker compose -f docker-compose.prod.yml logs --no-color nginx`
  - 証明書配置と `APP_HOST` を確認
  - PC直公開時: `journalctl -u caddy -f` または `caddy validate --config /path/to/Caddyfile`
  - Tunnel fallback時: `cloudflared tunnel info <tunnel-name>` と `journalctl -u cloudflared -f`
- 症状: fixed QR の URL が旧URLのまま
  - `APP_HOST` / `PAY_BASE_URL` / `PUBLIC_BASE_URL` の一致を確認
  - `docs/pc-domain-hosting-runbook.md` の final URL rule に従い、仮QRと固定QRを混在させていないか確認

## Log collection
- 実行コマンド:
  - `bash scripts/deploy/collect-logs.sh`
- 収集内容:
  - docker compose logs
  - `journalctl -u jpyc-payment-terminal.service`
  - healthcheck結果
  - git commit hash
  - app version
  - env key一覧

## Controlled stop
- 本番（systemd管理ホスト）では、unitのimmutable運用（`--no-build --pull never` + `verify-release-image.mjs`）に従う。`docker compose down` や `--build` を含む手作業のcompose操作は行わない。
- 新規受付停止（推奨・監査ログ付き）:
  - kill switch APIで請求発行を停止する（`docs/74-runbook.md` の「インシデント時 kill switch 手順」参照）。
  - 代替手段として `.env.production` の `PAYMENTS_DISABLED=true` 変更後、`sudo systemctl reload jpyc-payment-terminal.service`（ExecReload = `up -d --no-build --pull never --force-recreate app worker nginx`）を適用する。
- 全停止:
  - `sudo systemctl stop jpyc-payment-terminal.service`
  - `docker compose down` はsystemd管理外でのみ使用し、実行した場合はevidenceに理由を記録する。

## Controlled restart
- `sudo systemctl restart jpyc-payment-terminal.service`（ホスト上のrebuildは行わない。イメージは `verify-release-image.mjs` が検証済みのdigestのみ使用する）
- `bash scripts/deploy/healthcheck.sh`
- `/readyz` と `/metrics?format=json` を再確認する。
- PC hosting の場合は app / worker / Caddy または cloudflared の restart 後に `bash scripts/deploy/check-public-host.sh .env.production` を再実行する。

## Evidence
- 障害時は [93-incident-drill](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/93-incident-drill.md) と同じディレクトリ規約で evidence を保存する。
- fixed QR 本印刷前には `pay.miyamibu.xyz` での公開確認結果を evidence に残す。

## Done when
- 一次切り分けとログ採取を1コマンドで開始できる。
- 起動/停止/再起動の手順が deployment pack と一致している。
