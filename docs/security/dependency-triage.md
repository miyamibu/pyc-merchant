# Dependency Triage — moderate npm audit findings

## Goal
`npm run audit` (=`npm audit --audit-level=high`) を exit 0 で通すための残課題と、それぞれの安全な解消経路を、`npm audit fix --force` を踏まないで判断できる形で残す。

## Status snapshot (2026-05-24 re-check, Node v25.8.1 on the audit host; runtime target Node 20.x)
- `npm audit --audit-level=high` → exit 0 (no high/critical)
- `npm audit` (default level) → 5 moderate advisories (unchanged since previous snapshot)
- `npm run audit` exit code → 0
- `npm run hygiene:deps-docker` → `ok: true`
- `npm audit fix --dry-run` → `"change": []`, `"changed": 0`, `"added": 0`, `"removed": 0` — currently a no-op without `--force`
- 商用判定 (`npm run commercial:validate:safe`) → `NO_GO`（理由は依存物ではなく、外部証跡・本番 env / policy URL 等が未充足。後述）

> **2026-05-24 handoff 監査セッションでの再確認（Node v22.22.0 / npm 10.9.4 のサンドボックス上）**
> `npm run audit` を再実行し、本表の 5 moderate advisory（実体 2 件: `qs` 経由と `ws` 経由）が**変化なし**で再現することを確認した。high / critical は 0。`npm audit fix --force` は本セッションでも実行していない。
> 監査ホストは Node v22.22.0 で、runtime target の Node 20.x でも snapshot header の Node v25.8.1 でもない点に注意。`npm audit` の結果は npm registry メタデータ依存のため Node バージョンに依存しないが、依存解消（`npm ci` / `npm install`）の最終確認は runtime target の Node 20.x で再実行すること。

### Upstream availability check (2026-05-24)
- `npm view express@latest version` → **`5.2.1`** （SemVer-major from current `^4.21.2`、`--force` 相当）
- `npm view express versions` の 4.x 系 latest → **`4.22.2`**
- `npm view express@4.22.2 dependencies` の `qs` → **`~6.15.1`** — つまり 4.x 系 latest にしてもまだ `qs` advisory 範囲（`6.11.1 - 6.15.1`）に入る
- `npm view qs versions` の latest → **`6.15.2`** （advisory fix 入り）
- 結論: `express@4.x` に `qs >= 6.15.2` を取り込んだリリースは **まだ存在しない**。`express@5.x` への移行は SemVer-major かつ本リポジトリで未検証のため、今回の trigger 条件「上流の非破壊的 release が出たら更新」を満たさない。よって `package.json` / `package-lock.json` は今回更新しない。

## Findings table

| Advisory | Severity | Affected | Why it's present | Safe remediation | `audit fix` exit | Notes |
|---|---|---|---|---|---|---|
| [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) — `qs` DoS via `qs.stringify` null/undefined in comma-format arrays when `encodeValuesOnly` is set | moderate (CVSS 5.3) | `qs@6.11.1-6.15.1` ← `body-parser` ← `express` | direct dep: `express ^4.21.2` resolves to `4.21.x` which pins `body-parser` / `qs` transitively。**2026-05-24 時点で `express@4.22.2` (4.x 系 latest) も `qs: ~6.15.1` を依存している** | `express@4.x` 側で `qs >= 6.15.2` を取り込んだリリースが出てから `npm install express@latest` → `package-lock.json` 差分レビュー → `npm install` → `npm audit` で 0 件確認 → commit。advisory メッセージは `fix available via npm audit fix` を示唆するが、`npm audit fix --dry-run` は現時点で `"changed": 0` （= 上流に非破壊 fix がまだ無いため実質 no-op） | `fixAvailable: true` だが dry-run では no-op | runtime target は `express@^4.21.2`。`express@5.x` への移行は SemVer-major、未検証 |
| [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) — `qs` DoS, transitive via `body-parser` | moderate | `body-parser@1.20.3-1.20.4` ← `express` | 同上 | `express@4.x` 上流が `qs >= 6.15.2` を取り込めば同時に解消 | dry-run no-op | 上記と同根 |
| [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) — `qs` DoS, transitive via `qs` 自体 | moderate | `qs@6.11.1-6.15.1` | 同上 | 同上 | dry-run no-op | 同根 |
| [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) — `ws` uninitialized memory disclosure | moderate (CVSS 4.4) | `ws@8.0.0-8.20.0` ← `ethers` | direct dep: `ethers ^6.15.0` pins `ws@8.x` で advisory 範囲に該当 | `ethers` 側で `ws >= 8.20.1` を取り込んだリリースを待つ。`npm audit fix --force` は `ethers@5.8.0` への **SemVer-major ダウングレード**となり破壊的 (`isSemVerMajor: true`) | non-zero | `npm audit fix --force` を踏むと `ethers` v6→v5 となり、chain monitor / wallet adapter / 署名検証が動作不能になる可能性が高い |
| [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) — `ws` advisory, transitive via `ethers` | moderate | `ethers >=6.0.0-beta.1` | 同上 | 同上 | non-zero | 同根 |

メタ:

- total moderate: 5（重複表示を含む — 実体は 2 advisory）
- high / critical: 0
- direct deps が起点: `express`, `ethers`

## Will `npm audit fix --force` work?
**実行しない。** 理由:

- `ethers` 側の advisory は `npm audit fix --force` で `ethers@5.8.0` への SemVer-major ダウングレードを引き起こす。`isSemVerMajor: true`。
- 本リポジトリでは `ethers@^6.15.0` の v6 API を以下で使用している:
  - `src/chain-monitor.mjs`(JsonRpcProvider, Interface, getAddress, parseUnits 等の v6 形)
  - `src/wallet-adapter.mjs`
  - その他 `src/server.mjs` のアドレス検証ロジック
- v5 では `ethers.utils.*` / `ethers.providers.*` 配下に API が再構成されており、ダウングレードはアプリ全体の手動移行を要する。
- `--force` 経由のダウングレードは PR / 設計レビュー無しで投入してはならない。

## Recommended next actions

1. **express**: 4.x 系の up-stream リリースを定期確認し、`qs >= 6.15.2` を取り込んだ `express@^4.x` が出た時点で `npm install express@latest` → `package-lock.json` 差分レビュー → `npm install` → `npm run audit` で 0 件確認 → commit。`npm audit fix` を選ぶ場合も差分レビュー必須。`--force` は禁止（`express@5.x` への SemVer-major bump となる）。
2. **ethers**: 6.x 系の up-stream リリースを定期確認し、`ws >= 8.20.1` を取り込んだ `ethers@^6.x` が出た時点で同様の手順で更新する。`ws` advisory が現行 commercial verdict をブロックしているわけではない（`npm run audit` は `--audit-level=high` のため moderate は素通り）が、`--audit-level=moderate` を CI で要求するときの blocker になる。`npm audit fix --force` は `ethers@5.8.0` への SemVer-major ダウングレードを引き起こし `src/chain-monitor.mjs` / `src/wallet-adapter.mjs` を破壊するため禁止。
3. それまでは `npm run audit` (`--audit-level=high`) の運用基準を維持し、moderate 件数 (5) を release record に記載する。
4. **`npm overrides` で `qs: 6.15.2` を強制ピン** することも技術的には可能だが、上流の意図しないバージョンを直接固定する判断は別途承認を要する。本ファイルでは選択肢として記録するに留め、現時点では実施しない。

## Effect on commercial verdict
これらの advisory は `npm run commercial:validate:safe` の `NO_GO` 理由ではない。`NO_GO` の主因（最新 snapshot より抜粋）:

- legal / AML / privacy / APPI approval gate 未承認
- JPYC contract gate / confirmation policy gate / backscan policy gate / settlement_unresolved_review_policy 未充足（production env 未投入）
- WALLET_ADAPTER_TYPE=mock / APP_SECRET / SERVICE_INGEST_SECRET / METRICS_SECRET / CORS_ALLOW_ORIGINS の dangerous flag (development env のため当然)
- customer policy URLs 未設定
- `EXT-001` / `EXT-002` / `EXT-003` / `EXT-004` evidence pending

依存 advisory を解消しても上記が解決しない限り `NO_GO` のまま。逆に、上記が揃っても本ファイルの依存課題は別途 release record に明示する必要がある。
