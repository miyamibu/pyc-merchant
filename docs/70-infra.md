# 70. Infra

## Goal
限定店舗実証の production-like 構成を、repo 内の実ファイルと一致する形で定義する。

## Implemented deployment assets
- [Dockerfile](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/Dockerfile)
- [docker-compose.prod.yml](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docker-compose.prod.yml)
- [systemd service](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/systemd/jpyc-payment-terminal.service)
- [nginx config](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/nginx/jpyc-payment-terminal.conf)
- [preflight](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/deploy/preflight.sh)
- [healthcheck](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/deploy/healthcheck.sh)
- [backup](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/deploy/backup-sqlite.sh)
- [restore drill](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/deploy/restore-drill.sh)
- [collect logs](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/deploy/collect-logs.sh)

## Runtime topology
- `app`
  - `src/server.mjs`
  - `/healthz`, `/readyz`, `/metrics`
- `worker`
  - `src/chain-monitor.mjs`
- `nginx`
  - TLS終端
  - reverse proxy
- shared runtime dir
  - `./runtime/data/app.db`
  - `./runtime/worker-state/chain-137.db`
  - `./runtime/backups`
  - `./runtime/logs`

`DB_PATH` は app の financial DB、`WORKER_STATE_DB_PATH` は worker の operational state DB として分離する。compose の app は worker state を read-only、worker は state directory を read/write でマウントし、worker に financial DB の volume を与えない。

## Operational rules
- secrets と approval ref は `.env.production` から供給する。
- `PAYMENTS_DISABLED=true` のまま receive address pool と readiness を確認してから受付を開ける。
- `backup-sqlite.sh` と `restore-drill.sh` を release evidence に残す。
- metrics / readiness は `METRICS_SECRET` 付きの運用経路から確認する。

## Validation
- `npm run deploy:check`
- `docker compose -f docker-compose.prod.yml config`
- `bash scripts/deploy/preflight.sh .env.production`
- `bash scripts/deploy/healthcheck.sh`

## Limit
- 現行構成は限定店舗実証向けであり、単一ホスト / SQLite / reverse proxy 前提。
- 多店舗同時負荷や広域営業展開の段階では DB と配備構成の再設計を行う。

## Done when
- docs の記述が repo 内の deployment asset と一致する。
- 実行コマンドが evidence と結び付いている。
