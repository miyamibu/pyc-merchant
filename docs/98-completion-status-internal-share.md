# 98. 完了一覧 / 未完了一覧（社内共有版）

## Goal
JPYC決済端末プロジェクトについて、現時点で「repo内で完了確認できていること」と「外部依存を含めて未完了のこと」を、社内共有向けに1枚で整理する。

## Context
- 本文書は `/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX` の現物コード、既存テスト、closeout 文書、最新の commercial verdict をもとに作成する。
- `repo内で完了` と `本番運用として完了` は分けて扱う。
- external pending は未実施のまま正直に残し、完了扱いしない。

## Constraints
- 実機確認、実送金、公開TLS、承認署名を repo 内の pass で代替しない。
- approval ref、secret 値、tx hash、署名、公開URLを捏造しない。
- protected path の証跡は参照のみとし、本書は共有用の要約として扱う。

## Snapshot
- Snapshot date: `2026-08-22`（2026-04-28版の内容は本セクション以降に履歴として保持）
- 本書は完全監査（2026-08-13完了）とその後のremediation作業を反映した最新版である。

### 2026-08-22 時点の状態（最新）

**判定: `NO_GO`（公開·配布·本番運用は不可 / ローカル開発·隔離検証は可）**

実施済み（repo内で確認可能）:

- 完全監査: Blocker4/Critical1/Major61/Minor29 を確定
  - [final-audit-report.md](/Users/mimac/.codex/visualizations/2026/08/09/019fe6b9-dac3-7c43-a20a-48e80850a521/jpyc-complete-audit/final-audit-report.md)
- Remediation（branch `codex/full-audit-remediation-20260813`, 未コミット差分）:
  - release gate署名束縛（C-001/B-001〜003相当）、settlement lineage/canonical transfer/invoice-atomicity、cursor pagination群、ops alert delivery、rollback identity手順、SSE/TTL・rate-limit上限、フィールド境界、UI pagination 等
  - 全Finding台帳: [remediation-finding-status.md](/Users/mimac/.codex/visualizations/2026/08/09/019fe6b9-dac3-7c43-a20a-48e80850a521/jpyc-complete-audit/remediation-finding-status.md)
- 検証: Node 24.17.0 Darwin arm64 公式で実作業ツリー **522/522 pass・0 fail/skip**、隔離公式Node 24.17.0 Dockerでも **522/522 pass**、**npm run check pass**、**npm audit 0 vulnerabilities**、**dependency/docker hygiene pass**
  - Chrome151の48幅・実機iPhone証拠は履歴証拠として維持。現在のpublic UI/server 8ランタイムファイルのSHAがその視覚証拠に一致するが、現行CI verifierはlocal evidenceを受理しないためcurrent CI visual evidenceは別途必要
  - 公開ホストは2026-08-22再測定で `root/healthz/readyz` 全て **HTTP 530**、Cloudflare **1033** と維持
  - 現スナップショット: branch `codex/full-audit-remediation-20260813`, HEAD `7be4531dc6b4a80dd8d66620a96a7c3455050bf5`, **107 dirty entries（75 tracked変更、32 untracked）**（本文書更新直前の基準値）

未完了（外部依存·人間承認。捏造禁止のため正直に残す）:

1. 公開ホスト `pay.miyamibu.xyz` が HTTP 530（Cloudflare 1033）— tunnel/origin修復に本番権限が必要
2. 法務·AML·Privacy·APPI承認の署名証跡（9項目の人間判定）
3. 外部証拠: 実JPYC送金·実refund·DR drill(RPO/RTO実測)·alert配信実運用·店舗訓練
4. iPhone 12 Safariでのfail-closed描画は2026-08-22に確認済み。ただしHashPort Wallet実機起動、実JPYC送金、Dynamic Type/VoiceOver等を含む完全実機matrixは未確認。

### 履歴（2026-04-28時点の記録）

- Latest canonical commercial verdict:
  - [COMMERCIAL_GO_SUMMARY.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/evidence/20260427T233711Z/COMMERCIAL_GO_SUMMARY.md)
- Fresh non-protected commercial verdict:
  - [COMMERCIAL_GO_SUMMARY.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/artifacts/commercial-validate/20260428T014551Z/COMMERCIAL_GO_SUMMARY.md)
- Canonical external blocker source:
  - [BLOCKED_EXTERNAL_VALIDATION.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/BLOCKED_EXTERNAL_VALIDATION.md)

## 完了していること

### 1. repo内の必須コード修正
- `cancel` 権限ガード追加済み
  - [src/server.mjs:7431](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/src/server.mjs:7431)
- `expire` 権限ガード追加済み
  - [src/server.mjs:7656](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/src/server.mjs:7656)
- mobile の同意前コピー禁止を UI / handler の両方で実装済み
  - [public/mobile.js](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/public/mobile.js)
- settlement summary の `cancelled` 集計追加済み
  - [src/settlement-export.mjs:29](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/src/settlement-export.mjs:29)

### 2. 既存テストスイートへの統合
- 権限回りは integration test に統合済み
  - [tests/server-integration.test.mjs](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/tests/server-integration.test.mjs)
- consent gate 回りは frontend security test に統合済み
  - [tests/frontend-security.test.mjs](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/tests/frontend-security.test.mjs)
- settlement summary 回りは accounting contract/export test に統合済み
  - [tests/accounting/settlement-export-contract.test.mjs:53](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/tests/accounting/settlement-export-contract.test.mjs:53)
- 一時的な独立 test file は残っていない

### 3. repo内の安全検証
- `npm run check` pass
- `npm run security:destructive` pass
- `npm test` pass
  - observed count: `171/171`

### 4. fresh commercial verdict の安全な再算出
- `commercial:validate:safe` で protected path を触らず `artifacts/` 配下へ出力可能
- fresh verdict と canonical latest verdict は一致
  - verdict: `NO_GO`
  - score: `1.0 / 10`
  - P0 blocker 一致
  - `EXT-001..004` pending 一致
  - 補足: safe verdict では `policy_urls_gate` を追加で可視化（P1）

### 4.1 repo-internal closeout polish（今回反映）
- safe commercial validate 導線を script 化
  - [run-commercial-validate-safe.mjs](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/production-validation/run-commercial-validate-safe.mjs)
  - [package.json](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/package.json)
- policy URL readiness を commercial validator で明示
  - [validate-commercial-go.mjs](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/production-validation/validate-commercial-go.mjs)
- status 用語を `review_required` canonical / `manual_review` alias に正規化
  - [mobile.js](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/public/mobile.js)
  - [terminal.js](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/public/terminal.js)

### 5. repo内で完了確認できる主要機能群
根拠母表:
- [95-mvp-done-evidence-matrix.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/95-mvp-done-evidence-matrix.md)

確認済み:
- `1 invoice = 1 receive_address`
- QR再発行後も旧 invoice 監視継続
- exact match paid
- expired 後着金 -> review / late payment
- 過入金 / 不足入金 / 重複入金
- CSV export
- audit / hash-chain 機能の repo内実装と検証導線
- drift detection
- evidence sanitization
- RPC / reorg / duplicate / restart / dead-letter 疑似障害対応
- 権限 / セキュリティ negative
- global / store / terminal kill switch

### 6. closeout 管理資料の整備
存在確認済み:
- [docs/open-questions.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/open-questions.md)
- [docs/11-regulatory-questions.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/11-regulatory-questions.md)
- [docs/80-approval-plan.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/80-approval-plan.md)
- [docs/87-go-no-go-evidence-matrix.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/87-go-no-go-evidence-matrix.md)
- [docs/91-go-no-go-checklist.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/91-go-no-go-checklist.md)
- [docs/92-legal-aml-appi-runtime-gates.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/92-legal-aml-appi-runtime-gates.md)
- [docs/88-approval-minutes-and-signoff.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/88-approval-minutes-and-signoff.md)
- [docs/97-commercial-release-record-template.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/97-commercial-release-record-template.md)

## 完了していないこと

### 1. 外部承認項目 Q-001〜Q-010
根拠:
- [docs/open-questions.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/open-questions.md)

未完了:
- Q-001 運用形態
- Q-002 登録・届出要否
- Q-003 対応チェーン確定
- Q-004 JPYCコントラクト確定値
- Q-005 期限300秒と完了判定ポリシー
- Q-006 返金ポリシー
- Q-007 返金ウォレット保管方式
- Q-008 ウォレット対応範囲
- Q-009 会計処理
- Q-010 本番Go判定条件

### 2. 規制・法務質問票 RQ-01〜RQ-10
根拠:
- [docs/11-regulatory-questions.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/11-regulatory-questions.md)

未完了:
- RQ-01〜RQ-10 すべて `外部承認が必要`

### 3. runtime approval gates の実運用反映
根拠:
- [docs/92-legal-aml-appi-runtime-gates.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/92-legal-aml-appi-runtime-gates.md)
- [docs/80-approval-plan.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/80-approval-plan.md)

未完了:
- `LEGAL_GATE_APPROVAL_REF`
- `AML_POLICY_APPROVAL_REF`
- `PRIVACY_POLICY_APPROVAL_REF`
- `APPI_POLICY_APPROVAL_REF`
- `APPI_RETENTION_POLICY_REF`
- `APPI_DELETION_PROCEDURE_REF`
- `APPI_DISCLOSURE_PROCEDURE_REF`
- `JPYC_CONTRACT_APPROVAL_REF`
- `CONFIRMATIONS_POLICY_APPROVAL_REF`
- `BACKSCAN_POLICY_APPROVAL_REF`

### 4. 本番 env / secret / host の確定投入
根拠:
- [.env.production.example](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/.env.production.example)
- latest commercial verdict

未完了:
- `APP_HOST`
- `PAY_BASE_URL`
- `PUBLIC_BASE_URL`
- `APP_SECRET`
- `SERVICE_INGEST_SECRET`
- `METRICS_SECRET`
- `TOKEN_CONTRACT`
- `RECIPIENT_ADDRESS`
- `APPROVED_JPYC_TOKEN_CONTRACT`
- `REQUIRED_CONFIRMATIONS`
- `MIN_REQUIRED_CONFIRMATIONS`
- `MONITOR_BACKSCAN_BLOCKS`
- `MIN_MONITOR_BACKSCAN_BLOCKS`
- `CORS_ALLOW_ORIGINS`
- `REOWN_PROJECT_ID`
- target env で `WALLET_ADAPTER_TYPE=mock` ではない状態の確認

### 5. 外部実証 EXT-001〜EXT-004
根拠:
- [BLOCKED_EXTERNAL_VALIDATION.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/BLOCKED_EXTERNAL_VALIDATION.md)
- latest canonical [COMMERCIAL_GO_SUMMARY.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/evidence/20260427T233711Z/COMMERCIAL_GO_SUMMARY.md)

未完了:
- EXT-001 実JPYC少額決済
- EXT-002 HashPort Wallet 実機起動
- EXT-003 公開 FQDN / TLS / nginx
- EXT-004 限定店舗オペ訓練

### 6. POC 証跡
未完了:
- POC-001
- POC-002
- POC-003

補足:
- 現行 validator 上は P2 項目だが、commercial prep の厚みとしては未完了

### 7. ポリシー公開URLの本番反映
根拠:
- [public/mobile.js](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/public/mobile.js)
- [docs/legal/customer-consent-requirements.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/legal/customer-consent-requirements.md)

未完了:
- 利用規約 公開URL
- プライバシーポリシー 公開URL
- 返金ポリシー 公開URL
- `POLICY_URLS` への書き戻し

### 8. 店頭掲示と写真証跡
根拠:
- [docs/storefront/posting-evidence-template.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/storefront/posting-evidence-template.md)

未完了:
- 店頭掲示実施
- 写真証跡
- スタッフ説明記録
- 承認署名

### 9. 人間の最終 sign-off
根拠:
- [docs/88-approval-minutes-and-signoff.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/88-approval-minutes-and-signoff.md)
- [docs/97-commercial-release-record-template.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/97-commercial-release-record-template.md)

未完了:
- 法務責任者 sign-off
- 会計責任者 sign-off
- 運用責任者 sign-off
- 技術責任者 sign-off
- human verdict の最終記録

### 10. Go/No-Go checklist 上の未充足
根拠:
- [docs/91-go-no-go-checklist.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/91-go-no-go-checklist.md)

未完了:
- G-001 法務承認
- G-002 会計承認
- G-003 運用承認
- G-005 実JPYC少額決済PASS
- G-012 秘密情報管理PASS の人間承認面

条件付き未完了:
- G-004 技術承認は repo内 validation 証跡はあるが、signed minutes 上の正式 sign-off は未確認

## いま言い切れること
- repo内で追加必須のP0コード修正は現時点で見当たらず、今回確認した closeout polish（safe validate / policy URL guard / status terminology）は repo 内で反映済み
- 本番Goの阻害要因は、repo内バグではなく外部承認・本番設定・実地証跡・sign-off
- したがって、次の作業の主戦場は repo 内ではなく、法務 / 会計 / 運用 / 技術の実運用タスク

## 次にやる順
1. 法務 / 制度 / 会計判断を確定し、approval ref を発行する
2. 本番 env / secret / public host / wallet adapter を確定する
3. `EXT-001..004` を実施して証跡化する
4. ポリシーURL反映と店頭掲示証跡を整える
5. `docs/88` と `docs/97` に sign-off を記録する
6. fresh `commercial:validate` を再実行し、`NO_GO` が解消したか確認する

## Done when
- 社内共有先が、本書だけで「repo内完了」と「外部未完了」を切り分けて把握できる
- 次の担当者が、自分の未完了タスクを迷わず引き取れる
