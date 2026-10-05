# JPYC小規模店舗向け Merchant Ops / Settlement Layer

## 概要
このリポジトリは、JPYCで「払えること」だけでなく、払われた後の現場運用を回すための non-custodial Merchant Ops / Settlement Layer 実装です。秘密鍵は保持せず、Polygon 上の JPYC 入金を invoice-first ledger で処理します。主な対象は小規模店舗、イベント、ポップアップ、実証現場です。

## このプロダクトの立ち位置
- この実装が取りに行くレイヤーは、決済ゲートウェイそのものではなく `Merchant Ops / Settlement Layer` です。
- 強みは `JPYCで払えること` 単体ではなく、`払われた後に店舗が困らないこと` にあります。
- 具体的には、invoice-first ledger、review queue、返金証跡、日次締め、監査ログ、dead-letter を含めて現場運用を支えます。

## 小規模チームとしての勝ち筋
- 大手が強い `信用・精算・加盟店網` を真正面から取りに行くのではなく、小規模店舗、イベント、実証現場に素早く合わせ込めることを価値にします。
- 例外理由、返金導線、締め処理、運用ガイドのような細かな業務改善を、現場フィードバックを受けて短いサイクルで更新できます。
- そのため、最初の導入対象は `全国標準` よりも `限定店舗で深く刺さる運用` を優先します。

## 実装済みの主要機能
- 端末ログインと権限管理
- 動的 invoice 発行と `/pay?ref=...` 公開導線
- receive address pool の在庫管理と再利用禁止
- 支払い状態遷移、late payment の自動レビュー化
- internal ingest と verified manual ingest
- review queue / refund request / refund verification
- reason_type ごとの次アクションガイドと返金候補額の下書き補助
- 監査ログ hash chain
- 日次締めと未解決レビューの集計
- review / refund / settlement / monitor を優先順で示す compact ops summary
- chain monitor の dead-letter retry と checkpoint 制御
- SSE + polling fallback による端末UI更新
- env flag で制御する read-only 診断モード

## non-custodial 境界
- このシステムは private key / seed phrase / mnemonic / keystore を生成・保存・預かりません。
- receive address pool は外部で準備済みの受取アドレス在庫を管理するだけです。
- refund は外部実行された tx を検証して状態を昇格させます。システム自身が送金署名を行いません。

## 開発セットアップ
```bash
cd /Users/mimac/Desktop/JPYC決済端末_MVP_UIUX
npm install
cp .env.example .env
npm start
```

サポート基準ランタイムは Node 24.17.0 です。CI は Node 24.17.0、Dockerfile は承認済み Node 24.17.0 image digest に固定しており、ローカルでも [`.nvmrc`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/.nvmrc) / [`.node-version`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/.node-version) に合わせて検証してください。別Nodeで動くことはありますが、release evidence の基準は Node 24.17.0 exact runtime です。

監視ワーカーは別プロセスで起動します。

```bash
npm run monitor
```

## 環境変数
- 開発用サンプル: [`.env.example`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/.env.example)
- 本番投入用テンプレート: [`.env.production.example`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/.env.production.example)

本番では以下が未設定だと起動しません。
- `APPROVED_JPYC_TOKEN_CONTRACT`
- `JPYC_CONTRACT_APPROVAL_REF`
- `LEGAL_GATE_APPROVED` / `AML_POLICY_APPROVED` / `PRIVACY_POLICY_APPROVED` / `APPI_POLICY_APPROVED`
- 各 approval ref
- `MIN_REQUIRED_CONFIRMATIONS` / `CONFIRMATIONS_POLICY_APPROVAL_REF`
- `MONITOR_BACKSCAN_BLOCKS` / `BACKSCAN_POLICY_APPROVAL_REF`
- 十分な長さの secret 類
- 非デフォルトの PIN / terminal code / Reown Project ID

商用 closeout で明示的に使う追加キー:
- `COMMERCIAL_GO_MODE`
  `true` にした時だけ商用 fail-closed 判定を `/readyz` と `npm run commercial:validate` で有効化します。
- `SETTLEMENT_UNRESOLVED_REVIEW_POLICY`
  canonical 値は `block` です。商用判定では未解決 review を block し、旧フラグ `SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS` は後方互換用としてのみ残しています。
- `DIAGNOSTIC_MODE_APPROVAL_REF`
  `DIAGNOSTIC_MODE_ENABLED=true` を本番で一時有効化する場合の承認 ref です。
- `MANUAL_INGEST_APPROVAL_REF`
  `ALLOW_MANUAL_PAYMENT_INGEST=true` を本番で一時有効化する場合の承認 ref です。

主要 gate の canonical validation path:
- production config drift: `npm run deploy:check` と `npm run production:validate:env`
- commercial verdict: `COMMERCIAL_EVIDENCE_ROOT="$(mktemp -d)" npm run commercial:validate`
- runtime gate snapshot: `GET /readyz` with `Authorization: Bearer <METRICS_SECRET>`
- external evidence seed: `npm run evidence:external:prepare`

検証時のみ有効化する補助フラグ:
- `DIAGNOSTIC_MODE_ENABLED=true`
  端末UIの現在請求カードに read-only 診断パネルを表示します。wallet payload、copy fallback、TTL、SSE / polling 状態、reissue lineage を確認できます。
  production では常時有効にせず、実機検証や障害切り分けの時だけ明示的に切り替えてください。

## 本番前の必須準備
1. 受取アドレスを `/api/v1/admin/receive-addresses:import` で投入する。
2. `PAYMENTS_DISABLED=true` のまま `/readyz` を確認し、approval summary が揃っていることを確認する。
3. `npm run check`, `npm test`, `npm audit --audit-level=high`, `npm run test:smoke` を実行し、証跡を保存する。
   可能なら `DIAGNOSTIC_MODE_ENABLED=true` で診断パネルのスクリーンショットも残す。
4. 実チェーンの少額入金、late payment、refund verification、kill switch、障害訓練の証跡を release record に添付する。

## 運用上の重要ルール
- `POST /api/v1/invoices` は `Idempotency-Key` 必須です。
- invoice の `chain/token/recipient` は常にサーバー管理で、request body からは上書きできません。
- `expired -> paid` は禁止です。期限後着金は `review_required` に遷移します。
- `POST /api/v1/payments/events:ingest` は tx receipt と ERC-20 Transfer を検証できた場合だけ本番で受け付けます。
- `POST /api/v1/refunds/:refundId/verify` で on-chain 検証に成功した場合のみ refund が `succeeded` になります。
- SSE は invoice ごとの短命 token を発行して接続します。長寿命 session token を EventSource に直接使いません。

## テスト
```bash
npm run check
npm test
npm run test:serial
npm run audit
npm run test:smoke
npm run test:audit-chain
npm run deploy:check
npm run production:validate
npm run production:validate:env
npm run hygiene:deps-docker
npm run evidence:device:prepare
npm run evidence:external:prepare
npm run ci:verify:github -- --repo <owner>/<repo> --workflow ci.yml
npm run ci:verify:github -- --repo <owner>/<repo> --workflow ci.yml --dry-run
```

`npm test` が標準の回帰コマンドです。`npm run test:serial` は Node/runtime 差分や将来の並列競合を切り分けるための再現用コマンドです。2026-04-22 時点では両方とも pass し、直列実行だけが遅いことを確認しています。

`npm run production:validate` は既定で [`docs/production/evidence`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/evidence) に証跡を書き出します。ローカル監査や一時確認で正本 evidence を増やしたくない場合は、`PRODUCTION_EVIDENCE_ROOT="$(mktemp -d)" npm run production:validate` のように一時ディレクトリへ退避してください。

`npm run commercial:validate` は既定で `COMMERCIAL_EVIDENCE_ROOT/<timestamp>/` に `commercial-go-validation.json`、`commercial-go-scorecard.md`、`COMMERCIAL_GO_SUMMARY.md` を出力します。ローカル監査で repo 直下の正本 evidence を増やしたくない場合は、`COMMERCIAL_EVIDENCE_ROOT="$(mktemp -d)" npm run commercial:validate` を使ってください。

`npm run evidence:external:prepare` は `EXT-001..004` だけでなく `POC-001..003` の pending template も同じ evidence dir に生成します。商用準備のドラフトを始めるときはこのコマンドを先に実行してください。

CI でも以下を自動検証します。
- `npm run check`
- `npm test`
- `npm run audit`
- `npm run test:smoke`
- `npm run test:audit-chain`
- `npm run deploy:check`
- `docker build .`
- `docker compose -f docker-compose.prod.yml config`

Docker が入っていないローカル端末では、上記 2 つは `environment limitation` として扱って構いません。その場合は Docker-capable host で同じ 2 コマンドを実行し、結果を release record に記録してください。

`.env.production` 実値が準備できたら、次の 1 コマンドで drift と RPC 到達確認まで実行できます。

```bash
npm run production:validate:env
```

## 本番配備パック
- Dockerfile: [`Dockerfile`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/Dockerfile)
- Compose: [`docker-compose.prod.yml`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docker-compose.prod.yml)
- systemd: [`deploy/systemd/jpyc-payment-terminal.service`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/systemd/jpyc-payment-terminal.service)
- nginx: [`deploy/nginx/jpyc-payment-terminal.conf`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/nginx/jpyc-payment-terminal.conf)
- Caddy template: [`deploy/caddy/Caddyfile.example`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/caddy/Caddyfile.example)
- Cloudflare Tunnel template: [`deploy/cloudflared/config.example.yml`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/deploy/cloudflared/config.example.yml)
- deployment runbook: [`docs/71-production-deployment.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/71-production-deployment.md)
- PC + domain hosting runbook: [`docs/pc-domain-hosting-runbook.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/pc-domain-hosting-runbook.md)
- backup / restore: [`docs/72-backup-restore-runbook.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/72-backup-restore-runbook.md)
- operations: [`docs/73-operations-runbook.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/73-operations-runbook.md)

## 独自ドメイン1個 + つけっぱなしPC で公開する場合
- mainline は `https://pay.miyamibu.xyz` を最終公開URLに固定し、`APP_HOST` / `PAY_BASE_URL` / `PUBLIC_BASE_URL` を同じ origin に揃えます。
- `80/443` を直公開できるなら `Caddy` で無料 HTTPS を張ります。
- 直公開できない、または `CGNAT` が疑われるなら `Cloudflare Tunnel` を fallback にします。
- 内部検証用の一時 URL と、お客様に見せる fixed QR の URL を混同しません。fixed QR は最終URL確定後に作ります。
- 実運用前の確認は `npm run deploy:pc:preflight`、公開後のURL確認は `npm run deploy:public-host:check -- <env-file> <public_entry_token> '<signed_pay_url>'` を使います。

## 店頭 Mac 内完結トポロジ（local_store_terminal）
- `DEPLOYMENT_TOPOLOGY=local_store_terminal` を選ぶと、アプリは loopback のみで待ち受け、公開顧客支払いページ（signed `/pay?ref=` や fixed 入口 QR）を持ちません。代わりに invoice 専用の送金用ウォレット QR（chain 137 / 公式 JPYC / 承認 recipient / exact amount）を店頭画面に表示します。
- 詳細・要件・launchd 自動起動・ロールバック: [`docs/100-local-store-terminal-topology.md`](docs/100-local-store-terminal-topology.md)
- 上記「独自ドメイン」セクションは `public_cloud` トポロジの要件です。

## 実証リリース検証パック
- 実行: `npm run production:validate`
- 証跡保存先: [`docs/production/evidence`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/evidence)
- 一時出力先での安全な実行: `PRODUCTION_EVIDENCE_ROOT="$(mktemp -d)" npm run production:validate`
- 計画: [`docs/90-production-validation-plan.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/90-production-validation-plan.md)
- 限定店舗チェック: [`docs/91-limited-store-release-checklist.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/91-limited-store-release-checklist.md)
- 実機確認: [`docs/92-real-device-validation-checklist.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/92-real-device-validation-checklist.md)
- 障害訓練: [`docs/93-incident-drill.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/93-incident-drill.md)
- 締め証跡: [`docs/94-closing-and-settlement-evidence.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/94-closing-and-settlement-evidence.md)
- 外部未実行一覧: [`docs/production/BLOCKED_EXTERNAL_VALIDATION.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/BLOCKED_EXTERNAL_VALIDATION.md)
- Codex prompt index: [`docs/prompts/README.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/prompts/README.md)
- Codex operation instructions: [`CODEX_INSTRUCTIONS.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/CODEX_INSTRUCTIONS.md)

このパックの pass は repo/deploy validation の通過証跡であり、EXT-001..004 の Required external evidence を閉じません。限定店舗 GO は [`docs/production/BLOCKED_EXTERNAL_VALIDATION.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/BLOCKED_EXTERNAL_VALIDATION.md) の Required がすべて証跡付きで閉じてから判定してください。

## 参照ドキュメント
- [Chain / Token Production Policy](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/21-chain-and-token-spec.md)
- [Runbook](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/74-runbook.md)
- [Chain Monitoring](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/50-chain-monitoring.md)
- [Refund Policy and Flow](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/62-refund-policy-and-flow.md)
- [Legal / AML / APPI Runtime Gates](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/92-legal-aml-appi-runtime-gates.md)
- [Production Validation Plan](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/90-production-validation-plan.md)
