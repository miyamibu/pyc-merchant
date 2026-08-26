# 100. Local Store Terminal Deployment Topology

## Goal
店頭 Mac 上で完結する JPYC 決済端末トポロジ `local_store_terminal` を、既存の `public_cloud` トポロジに**追加**として提供する。`public_cloud` の要件は一切緩和しない。

## DEPLOYMENT_TOPOLOGY
- 値: `public_cloud`（既定・従来動作） / `local_store_terminal`（追加）。
- 未設定や空は `public_cloud` 扱い。未知の値は起動時 FATAL。
- 実装: `src/deployment-topology.mjs`（構造検査）、`src/server.mjs`（起動ゲートと経路制御）。

## local_store_terminal の要件（すべて fail-closed）
1. **ループバック束縛**: `APP_BIND_HOST=127.0.0.1`（または `::1` / `localhost`）。`0.0.0.0` 等は起動失敗。
2. **公開顧客支払いページの廃止**: `/pay`, `/t/:token`, `/mobile.html`, `/api/v1/public/*` は 404 `PUBLIC_CUSTOMER_PAYMENT_DISABLED_BY_TOPOLOGY`。署名済み公開支払い URL を顧客に発行しない。`APP_HOST` / `PAY_BASE_URL` は `http://127.0.0.1:<port>` の明示指定必須（`PUBLIC_BASE_URL` へのフォールバックは禁止）。さらに `PUBLIC_PAYMENT_PAGE_ENABLED=false` の**明示設定必須**（未設定・true は起動失敗）。
3. **公開ポリシー起点（Site origin）**: 公式キーは `PUBLIC_POLICY_ORIGIN`（origin-only HTTPS、port 443）。末尾 `/` は正規化する。`PUBLIC_BASE_URL` は互換フォールバックとして引き続き受け付けるが、両方を設定した場合は同一 origin でなければ起動失敗。店舗ごとの利用規約 / プライバシー / 返金ポリシー URL は、この origin の `/terms` / `/privacy` / `/refund-policy` と完全一致する場合だけ同意対象として受理する。
4. **デモ／手動／モック／診断の無効化**: `ENABLE_PUBLIC_PAYMENT_SIMULATION=false`, `DEMO_CONTROLS_ENABLED=false`, `ALLOW_MANUAL_PAYMENT_INGEST=false`, `ENABLE_PROVIDER_RAIL_MOCK=false`, `DIAGNOSTIC_MODE_ENABLED=false`。`TRUST_PROXY` / `TRUST_PROXY_HOPS` / `TRUST_PROXY_CIDRS` は無効（リバースプロキシなし直結）。
5. **受取アドレス / RPC / トークンメタデータ承認**: `RECIPIENT_ADDRESS`（実在 EVM アドレス、ゼロアドレス禁止）、`RPC_URLS_137`（または `RPC_URLS`）、公式 JPYC コントラクト一致＋`APPROVED_TOKEN_NAME` / `APPROVED_TOKEN_CODE_HASH` / `APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH` ピン（production-like 既存ゲート）。
6. **単一チェーン**: `CHAIN_ID=137` かつ `ENABLED_PAYMENT_CHAIN_IDS=137` のみ。
7. **監査 / バックアップ / ワーカー分離**: `WORKER_STATE_DB_PATH` は `DB_PATH` と別ファイル必須、`BACKUP_DIR` 明示必須。監査証跡はアプリ台帳 DB 内に維持（既存どおり）。
8. **Mac 運用準備 inputs**: `LOCAL_TERMINAL_OPERATOR_READINESS_REF` に下記チェックリスト完了を示す参照（例: `MAC-READY-2026-08`）を必須。プレースホルド的値は起動失敗。

## 送金用ウォレット QR（正確性）
- 店頭スタッフ画面は fixed 入口 QR の代わりに、**当該 invoice 専用**の EIP-681 ERC-20 transfer URI を QR 表示する:
  `ethereum:<official JPYC token>@137/transfer?address=<invoice recipient>&uint256=<exact atomic amount>`
- chain（137）/ トークン（公式コントラクト）/ 受取アドレス（サーバ管理プールまたは承認 recipient）/ 金額（atomic units, exact）はすべて請求レコード由来で、クライアント側で組み替えられない。
- API では invoice 作成レスポンスの `qr_payload` / `payment_uri` がこの URI になり、`payment_url` / `pay_url` は local トポロジでは返さない。後方互換のため `NOT NULL` の `invoices.payment_url` には空文字を保存し、署名付き支払い参照を生成しない。traceability は invoice ID、checkout session、payment evidence、review/refund、settlement、audit の参照で維持する。
- **同意保存までの送金 QR 非表示**: サーバは当該 invoice の `invoice_consents` 行が存在するまで `payment_uri` / `qr_payload` / `wallet_url` / `wallet_deeplink` を返さない（fail-closed）。UI も二重にゲートする。
- 検証: `tests/deployment-topology.test.mjs`、validator `local_topology_wallet_transfer_qr_exactness`。

## 規約同意の記録（スタッフ記録型、local 専用）
- エンドポイント: `POST /api/v1/invoices/:invoiceId/policy-consent`（認証済み端末セッション + `invoice.create` 権限）。local トポロジ以外では 404。公開 consent endpoint とは別経路であり、流用しない。
- 同意対象: 当該 invoice の policy snapshot（Sites の terms / privacy / refund の公開済み内容に対応する URL・バージョン・SHA-256 ハッシュ）。リクエストボディは 3 バージョンのみを受け付け、それ以外のキー（=PII）は 409 `POLICY_VERSION_MISMATCH` で拒否する。
- 保存: `invoice_consents` テーブルに請求ごと 1 行（UNIQUE(invoice_id)）。監査ログ action `customer_policy_consent_staff` にバージョン・ハッシュ・URL・セッション/スタッフ ID を記録し、挿入と監査は同一トランザクションで不可分。
- 再発行: 同意は請求単位のため、再発行後の新 invoice は必ず未同意から開始し、送金 QR は再び非表示になる。
- UI: 端末画面に同意パネル（チェックボックス＋記録ボタン）を表示し、記録成功後にのみ送金 QR を描画する。

## 端末 UI の Sites 案内
- ログイン応答の `public_policy_origin` / `public_policy_links`（terms / privacy / refund_policy / security の絶対 URL）を元に、端末 UI に規約等へのリンクと**決済QR とは別の**「Site 案内 QR」（origin のみをエンコード）を表示する。
- origin は origin-only HTTPS のみ検証通过時に描画し、それ以外はカードごと非表示（fail-closed）。決済 QR キャンバスとは別キャンバスで、「決済用ではありません」ラベル付き。

## launchd 自動起動（macOS）
- `deploy/launchd/com.jpyc.terminal.local.plist.example`: アプリ（`src/server.mjs`）。
- `deploy/launchd/com.jpyc.chain-monitor.local.plist.example`: チェーンワーカー（`src/chain-monitor.mjs`）。
- 両 plist とも `deploy/launchd/run-env-safe.mjs`（安全ランナー）経由で起動し、Node は **v24.17.0 固定**の絶対パス（`__NODE24_BIN__`）を指定する。ランナー自体も実行時バージョンが一致しない起動を拒否する。
- 安全ランナーの保証:
  - `.env.production` は明示パスで読み込み、**mode 0600 以外は起動失敗**。秘密情報の値は一切表示しない（不正行は行番号と理由コードのみ）。
  - env 行は厳密解析（キー書式、重複、`export` 前置き、巨大値などを拒否）。値は展開・引用処理なしで子プロセスへ渡す。
  - シェルを経由しない（`spawn` の配列引数 + `shell: false`）ため shell injection 成立余地がない。
  - working directory（`--cwd`、realpath 一致）と実行対象（allowlist、cwd 内相対パスのみ）と実行バイナリ（`--allow-exec`、realpath 比較）を検証する。
- 導入要領:
  1. `__REPO_DIR__` / `__NODE24_BIN__` / `__LOG_DIR__` を実環境へ置換。`chmod 600 .env.production` を確認。
  2. `cp` 先は `~/Library/LaunchAgents/`、`launchctl bootstrap gui/$UID <plist>` で登録。
  3. `launchctl kickstart -k gui/$UID/<label>` で再起動確認、`launchctl print gui/$UID/<label>` で状態確認。
- KeepAlive あり。異常終了時は自動再起動されるが、連続失敗時は手動介入（ログは `__LOG_DIR__`）。

## launchd 定期ジョブ（backup / health-watch / audit-watch）
アプリ・ワーカーに加えて、次の 3 つの plist テンプレートを追加する。いずれも同じ安全ランナー経由で、Node は **v24.17.0 固定**の実パス
`/Users/mimac/Library/Application Support/JPYC Terminal/runtime/node-v24.17.0-darwin-arm64/bin/node`
をピン留めする（テンプレートに literal 記載済み。`Application Support` の空白含め変更しない）。

| plist テンプレート | label | 対象 | 実行タイミング |
| --- | --- | --- | --- |
| `deploy/launchd/com.jpyc.backup.local.plist.example` | `com.jpyc.backup.local` | `deploy/launchd/targets/backup-sqlite.mjs` | 毎日 03:30（`StartCalendarInterval`） |
| `deploy/launchd/com.jpyc.health-watch.local.plist.example` | `com.jpyc.health-watch.local` | `deploy/launchd/targets/health-watch.mjs` | 60 秒ごと（`StartInterval`）+ `RunAtLoad` |
| `deploy/launchd/com.jpyc.audit-watch.local.plist.example` | `com.jpyc.audit-watch.local` | `scripts/verify-audit-chain.mjs`（既存を再利用・無変更） | 600 秒ごと（`StartInterval`）+ `RunAtLoad` |

- ランナー allowlist（`run-env-safe.mjs` の `TARGET_ALLOWLIST`）は `src/server.mjs`, `src/chain-monitor.mjs`, `scripts/verify-audit-chain.mjs`, `deploy/launchd/targets/backup-sqlite.mjs`, `deploy/launchd/targets/health-watch.mjs` のみ。同ディレクトリ内の他ファイルは存在しても起動拒否。
- **backup**: `deploy/launchd/targets/backup-sqlite.mjs` は既存 `scripts/deploy/backup-sqlite.sh` をそのまま再利用する薄いラッパー。`DB_PATH` / `BACKUP_DIR` が `.env.production`（0600）由来で設定されていない場合は fail-closed で異常終了し、推測パスへ fallback しない。シェルスクリプトは `/bin/bash <絶対パス>` の固定配列引数で起動（eval・文字列連結なし）。ラッパーは pinned Node の bin ディレクトリを `PATH` 先頭に付与し、スクリプト内 `node` が同一バージョンで解決されることを保証する。バックアップは `BACKUP_DIR/app-<UTC時刻>.sqlite3`（mode 0600）として追記され、**既存バックアップや業務レコードを削除しない**。
- **health-watch**: `deploy/launchd/targets/health-watch.mjs` が loopback `http://127.0.0.1:<APP_PORT>/healthz` の HTTP 200 + `ok:true` を要求し、さらに `WORKER_STATE_DB_PATH` を read-only で開いてチェーンワーカーの鮮度（`worker:<CHAIN_ID>:last_cycle_at` が `WORKER_STALE_SEC` 秒以内・未来時刻でない、`rpc_count >= 1`、`last_checkpoint` 存在）を検証する。非 loopback bind 指定・設定欠落・DB 未読取・タイムアウトはすべて非ゼロ終了（fail-closed）。出力は 1 行 JSON のログのみで、**外部アラート送信は一切主張しない**（通知はログと exit code のみ。監視は運用者が行う）。
- **audit-watch**: 既存 `scripts/verify-audit-chain.mjs` を無変更で再利用。`DB_PATH` を read-only で開き、`audit_logs` ハッシュチェーンと `audit_epochs` attestation を毎回全件再計算し、1 行でも破損があれば非ゼロ終了＋構造化エラー JSON（fail-closed）。こちらも外部アラート送信は行わない。

### 停止シグナルと health contract
- launchd の安全ランナーは `SIGTERM` / `SIGINT` / `SIGHUP` を子プロセスへ転送する。アプリ本体が graceful shutdown として扱うのは `SIGTERM` / `SIGINT` であり、二重停止を無視し、定期タイマーを停止し、HTTP server の `close` 完了後に worker-state DB と台帳 DB を閉じて exit 0 とする。`SIGHUP` による設定再読込は実装しないため、設定変更は停止・再起動で反映する。
- terminal / chain-monitor plist は `KeepAlive=true`、`ThrottleInterval=10`、`ExitTimeOut=30`。30 秒以内に graceful shutdown が完了しない場合、launchd が強制終了へ進む可能性がある。`SIGKILL` は捕捉・転送できないため、監査ログや台帳 DB を直接削除して復旧してはならない。
- `GET /healthz` の成功 contract は HTTP 200 JSON `{ "ok": true, "service": "jpyc-terminal-production", "now": "<ISO-8601>" }`。認証不要だが最小情報だけを返す。`/metrics` は `Authorization: Bearer <METRICS_SECRET>` 必須であり、health 代替として無認証公開しない。
- health-watch plist は起動時および 60 秒間隔で実行する。各実行は HTTP 5 秒、全体 15 秒を上限とし、loopback `/healthz` に加えて worker の最終 cycle、RPC count、checkpoint、`WORKER_STALE_SEC` を検証する。非 200、JSON 不正、DB unreadable、未来時刻、stale、RPC/checkpoint 欠落は非ゼロ終了する。成功は structured JSON 1 行と exit 0 であり、外部通知の成功を意味しない。

### install / 確認 / unload（rollback）
共通手順（`<PLIST>` は各テンプレートを `~/Library/LaunchAgents/` へコピーした実ファイル名、`$UID` はオペレータ UID）:

```
# install（事前に __REPO_DIR__ / __LOG_DIR__ を置換し、chmod 600 .env.production を確認）
cp deploy/launchd/<example>.plist.example ~/Library/LaunchAgents/<PLIST>
plutil -lint ~/Library/LaunchAgents/<PLIST>
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/<PLIST>

# 手動実行 / 状態確認
launchctl kickstart -k gui/$UID/<label>
launchctl print gui/$UID/<label>

# unload / rollback（停止のみ。DB や証跡は削除しない）
launchctl bootout gui/$UID ~/Library/LaunchAgents/<PLIST>
rm ~/Library/LaunchAgents/<PLIST>   # テンプレート実ファイルのみ。業務データではない
```

### ログパスとローテーション
- 各ジョブの標準出力/標準エラーは `__LOG_DIR__/` 配下（例: `terminal.out.log`, `chain-monitor.out.log`, `backup.out.log`, `backup.err.log`, `health-watch.out.log`, `health-watch.err.log`, `audit-watch.out.log`, `audit-watch.err.log`）。
- ローテーション例: `deploy/launchd/com.jpyc.local.newsyslog.conf.example` を `/etc/newsyslog.d/jpyc-local.conf` として導入（要 sudo、7 世代・bzip2 圧縮・サイズ閾値）。dry-run は `sudo newsyslog -n -v -f /etc/newsyslog.d/jpyc-local.conf`。rollback は当該 conf ファイルの削除のみ。
- 注意: launchd は stdout/stderr の fd を保持し続けるため、newsyslog の rename 後も稼働中プロセスは旧 inode に追記する。ファイル入れ替えを確実にするにはローテーション後に `launchctl kickstart -k gui/$UID/com.jpyc.terminal.local` 等でジョブを再起動する。conf 内 `N` フラグは syslogd への不要なシグナルを抑止する。

### 分離復元ドリル（isolated drill）
- `tests/launchd-backup-restore-drill.test.mjs` は `mkdtemp` 専用ディレクトリ内だけで完結する: フィクスチャ SQLite（有効な監査ハッシュチェーン付き）→ 実 `scripts/deploy/backup-sqlite.sh` でバックアップ（mode 0600 検証）→ `quick_check` + 件数/センチネルデータ照合 + `scripts/verify-audit-chain.mjs` 再検証 → 実 `scripts/deploy/restore-drill.sh` で復元ドリル → 改ざん検知の fail-closed 確認 → 自ディレクトリの self-cleanup。
- `scripts/deploy/restore-drill.sh` 自体も監査チェーンに加えて**業務レコード整合を検証する**: コア業務テーブル（stores / terminals / invoices / payment_events / review_cases / refund_requests / audit_logs）の存在と `PRAGMA foreign_key_check` 違反ゼロを要求し、欠落・破損のあるバックアップは非ゼロ終了する。テストでは業務テーブルを欠くフィクスチャ改変コピーで fail-closed を確認する。
- リポジトリの `runtime/` / `data/` / 保護パス・業務 DB には一切触れない。実機での定期確認はこのテストを pinned Node で実行する:
  `"/Users/mimac/Library/Application Support/JPYC Terminal/runtime/node-v24.17.0-darwin-arm64/bin/node" --test tests/launchd-backup-restore-drill.test.mjs`

- 注: 上記は plist テンプレートとランナーの静的保証であり、実 Mac への launchctl 登録・watcher 動作の実機検証完了を主張するものではない。

## ロールバック指針
- アプリ単体: `launchctl bootout gui/$UID/<label>` で停止し、直前リリースへは Git タグ／`RELEASE_ID` を用いて `git checkout` 後 `npm ci` → 再 bootstrap。DB は `scripts/deploy/backup-sqlite.sh` + `restore-drill.sh` の手順に従う（保護対象ランタイム削除は行わない）。
- トポロジ単体: `.env` の `DEPLOYMENT_TOPOLOGY` を `public_cloud` へ戻し、nginx/Caddy 構成（`deploy/nginx` or `deploy/caddy`）で再公開。local 固有キーは残置しても無害（public_cloud では未使用）。ただし production-like 実行では、**値が設定済みの `PUBLIC_POLICY_ORIGIN` が origin-only 公開 HTTPS URL でない場合は起動時に FATAL となる**（無効値の黙視を防ぐ fail-fast。未設定なら従来どおり任意・不問）。
- ロールバック後も監査ログ・決済証跡は削除せず状態遷移で扱う。

## pay.miyamibu.xyz の扱い（歴史的事実と現行条件の分離）
- **現行の成功条件（active）**: `public_cloud` トポロジにおいてのみ、`APP_HOST` / `PAY_BASE_URL` / `PUBLIC_BASE_URL` 一致公開 origin として `pay.miyamibu.xyz` が要求される（`tests/production-like-startup.test.mjs`, `tests/pc-hosting-docs.test.mjs`, `docs/pc-domain-hosting-runbook.md`, nginx/Caddy/cloudflared 構成例）。
- **歴史的証拠（historical evidence）**: `docs/production/evidence/` 配下や過去完了報告（`docs/98-completion-status-internal-share.md` 等）の `pay.miyamibu.xyz` 記録は、当時の public_cloud 検証の証拠であり、`local_store_terminal` の成功条件ではない。
- **local_store_terminal での扱い**: 当該ドメインを fixed QR や支払いページに埋め込む要件は消える。代わりに `PUBLIC_POLICY_ORIGIN`（公開 Site 起点。`PUBLIC_BASE_URL` は同一 origin の互換値）が外部依存となる。validator は `--deployment-topology local_store_terminal` 時に loopback origin と公開 policy origin の分離を強制する。

## Validation
- `node --test tests/deployment-topology.test.mjs`
- `node scripts/production-validation/validate-production-config.mjs --deployment-topology local_store_terminal --skip-rpc --allow-empty`（構造事前点検）+ 実環境では RPC メタデータ検査付きで実行。
- `npm run check` / `npm run security:destructive` / `npm run test:serial`

## Done when
- `DEPLOYMENT_TOPOLOGY=local_store_terminal` で上記 1〜8 と `PUBLIC_PAYMENT_PAGE_ENABLED=false` が満たされ、違反は起動時に FATAL で落ちる。
- `public_cloud` の既存テスト・挙動が一切変わらない。
- 送金 QR が chain 137 / 公式トークン / 承認 recipient / exact amount で生成され、公開支払いページが存在しない。
- 規約同意（invoice 単位・監査ログ付き）の記録が完了するまで送金 QR が表示されず、再発行後は同意を取り直す。
- 端末 UI に Sites の terms / privacy / refund / security リンクと決済用でない Site 案内 QR が表示される。
