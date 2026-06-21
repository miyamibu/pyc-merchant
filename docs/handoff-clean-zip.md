# Clean Source ZIP Handoff

## Goal
非カストディ型 JPYC Merchant Ops / Settlement Layer のソースを、運用環境・ローカル証跡・秘密情報を含めずに第三者へ受け渡せる ZIP を作る。
node_modules / .git / data / runtime / artifacts / 私的証跡 / 秘密情報を一切含めず、ASCII の root フォルダ名（`jpyc-merchant-ops/`）で出力する。

## Ship the generated clean ZIP, not the working tree
**元 ZIP（手元の作業ツリーをそのまま固めたもの）を成果物として配布しない。**
作業ツリーには `node_modules/`, `.git/`, `data/`, `runtime/`, `artifacts/`, `deliverables/`, `__MACOSX/`, `.DS_Store`, `.claude/settings.local.json`, `.claude/launch.json`, ローカル DB / 証跡 / 秘密情報が必ず含まれる。
配布物は必ず `npm run handoff:zip` で生成した clean ZIP（`jpyc-merchant-ops-<UTC stamp>.zip`）を使う。生成時に staging ディレクトリへ `handoff:audit` が自動実行され、禁止物ゼロが確認できた場合のみ ZIP が出力される。

## What is excluded
クリーンソース ZIP は以下を含めない。

- 依存物・キャッシュ: `node_modules/`, `npm-debug.log*`, `yarn-debug.log*`, `pnpm-debug.log*`
- リポジトリ状態: `.git/`, `.github/`, `.codex/`, `.agents/`, `.claude/`（特に `.claude/launch.json`, `.claude/settings.local.json`）
- ランタイム / ローカル状態: `data/`, `runtime/`, `artifacts/`, `deliverables/`
- 私的証跡: `docs/production/evidence/*`（`.gitkeep` 以外）
- TLS / 鍵: `deploy/nginx/certs/*.pem`, `deploy/nginx/certs/*.key`, `*.pem`, `*.key`, `*.p12`, `*.pfx`
- 秘密情報: `.env`, `.env.production`, 任意の `credentials*`, `secret*`
- macOS ノイズ: `__MACOSX/`, `.DS_Store`
- ローカル DB / ログ / 一時: `*.db`, `*.db-shm`, `*.db-wal`, `*.sqlite`, `*.sqlite-shm`, `*.sqlite-wal`, `*.sqlite3`, `*.sqlite3-shm`, `*.sqlite3-wal`, `*.log`, `*.tmp`

含めるべきもの:

- `src/`, `public/`, `scripts/`, `tests/`, `docs/`, `deploy/`（証跡と鍵を除く）, `package.json`, `package-lock.json`, `Dockerfile`, `docker-compose.prod.yml`
- `.env.example`, `.env.production.example`, `.node-version`, `.nvmrc`, `.gitignore`, `.dockerignore`, `.gitleaks.toml`
- `CLAUDE.md`, `AGENTS.md`, `DESIGN.md`, `CODEX_INSTRUCTIONS.md`, `README.md`, `index.html`

## How to run
クリーンソース ZIP を作る:

```bash
npm run handoff:zip
```

出力先: `deliverables/handoff/jpyc-merchant-ops-<UTC timestamp>.zip`
内部 root フォルダ: `jpyc-merchant-ops/`

別の出力ディレクトリや root 名を指定:

```bash
node scripts/handoff/create-clean-source-zip.mjs --out path/to/out --root-name jpyc-merchant-ops
```

## How to validate
`handoff:zip` は出力前に `handoff:audit` を staging ディレクトリで自動実行し、禁止物が一切無いことを確認してから ZIP を生成する。リポジトリ自体に対する hygiene チェックは:

```bash
npm run handoff:audit
```

リポジトリ作業中は `node_modules/`, `data/`, `runtime/`, `.git/` 等が必ず存在するため、`npm run handoff:audit` をリポジトリ root で実行すると finding が出るのが期待動作。**ZIP 候補ディレクトリ（staging または展開済み ZIP）を引数で渡し、`ok: true` であることを確認する**。

```bash
# 既存 ZIP を展開して監査する例（REPO は本リポジトリ root の絶対パス）:
mkdir -p /tmp/jpyc-handoff-check && cd /tmp/jpyc-handoff-check
unzip -q /path/to/jpyc-merchant-ops-<stamp>.zip
node "$REPO/scripts/handoff/audit-source-hygiene.mjs" jpyc-merchant-ops
```

`ok: true`, `finding_count: 0` が表示されれば clean。
finding が出た場合は ZIP を **配布しない**。`findings_by_kind` の内容に従って `.dockerignore` / `.gitignore` / `scripts/handoff/audit-source-hygiene.mjs` / `scripts/handoff/create-clean-source-zip.mjs` の除外パターンを更新する。

`create-clean-source-zip.mjs`（ZIP 生成）と `audit-source-hygiene.mjs`（禁止物検出）の除外集合は一致させること。現状どちらも `node_modules/`, `.git/`, `data/`, `runtime/`, `artifacts/`, `deliverables/`, `__MACOSX/`, `.codex/`, `.agents/`, `.DS_Store`, `.env*`, `.claude/launch.json`, `.claude/settings.local.json`, DB/WAL/SHM/sqlite, `*.log`, `*.tmp`, `docs/production/evidence/*`（`.gitkeep` 以外）をカバーする。

## Node 20 clean validation（受け手側）
受け手は ZIP を展開後、**クリーン環境で Node 20.x を使って**依存を再構築し、検証を再実行してその出力を証跡として保存する。

```bash
node -v          # v20.x であることを確認（20.x 以外なら結果は参考値）
npm -v
npm ci           # package-lock.json から決定的に再構築
npm run check
npm test
npm run test:smoke
npm run test:audit-chain
npm run commercial:validate:safe
```

- `package.json` の `engines.node` / `.nvmrc` / `.node-version` はいずれも `20`。Node 20.x 以外（例: Node 22）で実行した結果は本リポジトリの正準環境ではなく、証跡には Node バージョンを明記する。
- 同梱しない `node_modules/` には開発機固有のネイティブビルド（`better-sqlite3` 等）が含まれる。別 OS / 別 Node で `npm ci` せずに流用すると `invalid ELF header` 等で失敗する。必ず受け手環境で `npm ci` する。

## Command exit code と commercial verdict は別物
`npm run commercial:validate:safe` は**コマンドとしては exit 0 で正常終了**することがあるが、その場合でも出力 JSON の `verdict` が `NO_GO` のことがある。

- コマンド成否（exit code）= 検証スクリプトが正しく走ったか。
- ビジネス判定（JSON `verdict`）= 商用 GO 可否。`GO` / `NO_GO` / スコアで表現される。

証跡・報告では必ずこの 2 つを分けて記載する。`exit 0` を「商用 GO」と読み替えてはいけない。EXT-001..004 や法務 / AML / APPI / 会計の承認 ref が揃わない限り `verdict` は `NO_GO` のまま維持する。

## .claude/settings.local.json / launch.json を共有しない理由
- `.claude/settings.local.json` には作業端末固有の権限許可・ローカル設定が入る。受け手環境では無効・有害になりうる。
- `.claude/launch.json` には作業端末の絶対パス（例: `/Users/<name>/Desktop/...`）が埋め込まれており、配布先では解決できないうえ環境情報の漏洩になる。
- どちらも clean ZIP から除外され、`audit-source-hygiene.mjs` でも検出される。

## Why node_modules and local DB files must not be shipped
- `node_modules/` には開発機固有のネイティブビルドが含まれ、受け手環境では再ビルドが必要。ZIP に同梱しても再現性は得られず、配布物が肥大化する。
- `data/`, `runtime/`, `*.db`, `*.db-wal`, `*.db-shm` には店舗の請求・支払い・レビュー・返金証跡・監査ログが含まれる。第三者への流出は事業者責務上のインシデントとなる。
- `.env`, `.env.production` には APP_SECRET / SERVICE_INGEST_SECRET / METRICS_SECRET 等の機微情報が入りうる。サンプルは `.env.example` / `.env.production.example` を使う。
- `docs/production/evidence/*` には EXT-001..004 の実証跡や本番検証時の関係者署名が含まれる。配布対象が違う。
- `.claude/launch.json`, `.claude/settings.local.json` には作業端末固有の絶対パス・権限設定が含まれる。

受け手は `npm ci` で依存物を再構築する。`.env.example` / `.env.production.example` を参考に本番値を改めて発行する。
