# PR1–PR14 / 40項目トレーサビリティ

status: draft
owner: engineering
last_verified_commit: `8d5130b456bebf8e40e5d772ab8a1c6c42dabb44`（今回の検証基準となる親コミット）
last_reviewed_at: `2026-07-28`
verification_scope: 2026-07-28時点の作業ツリー最終変更をコミット前に確認。最終コミットSHAはGit履歴で確認する。
release_decision: `NO_GO`（実JPYC、実機wallet、公開FQDN/TLS、外部承認、release artifactの外部証跡は未確認）

latest_local_validation: `PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run test:serial` = `377/377 PASS`、`npm run audit` = 0 vulnerabilities、`npm run deploy:check` = preflight PASS（Node `v24.14.1`; repository baseline `24.17.0`）

## 判定の意味

* `PASS`: 対応するローカルコードと回帰テストを確認済み。外部・実機・本番の合格を意味しない。
* `PARTIAL`: 実装または一部テストはあるが、要求全体、atomicity、実機、外部証跡のいずれかが未完了。
* `UNVERIFIED`: 対応する独立した回帰テストまたは実機・外部証跡を確認できていない。
* `BLOCKED_EXTERNAL`: リポジトリ内だけでは閉じられない外部条件。

## PR単位

| PR | 対象 | 状態 | 主な根拠 / 残り |
|---|---|---|---|
| PR1 | CI / Smoke / fixture / negative test | PASS | `.github/workflows/ci.yml`, `scripts/smoke-test.mjs`, `tests/ci-smoke-contract.test.mjs`。CI実行結果は外部未確認。 |
| PR2 | global transfer / observation / invoice link | PASS | `blockchain_transfers`, `transfer_observations`, `invoice_transfer_links` と `CROSS_INVOICE_TRANSFER_COLLISION` hold。`tests/payment-final-duplicate-integration.test.mjs`で異なるinvoiceへの同一transfer関連付けを確認。 |
| PR3 | identity / duplicate / split / deadline / amount integrity | PASS | `src/payment-logic.mjs`, `src/amounts.mjs`, `tests/payment-safety-logic.test.mjs`, `tests/chain-monitor.test.mjs`。 |
| PR4 | primary transfer / incident model | PASS | `review_incidents`, incident event / transfer link、`tests/payment-confirmation-incident-lifecycle.test.mjs`。 |
| PR5 | manual paid / auto-resolution restriction | PASS | confirmation incidentだけ自動解決、manual paidはcanonical + 二者step-up、同テスト。 |
| PR6 | refund lifecycle / challenge / finality | PARTIAL | requested/verified/finalized gate、nonce challenge、EIP-1271経路は実装。実chain reorgの独立E2Eは未確認。 |
| PR7 | receive address proof-of-control | PARTIAL | proof/sweep列と発行hard gateは実装。実EOA・実smart wallet・provider attestation証跡は未確認。 |
| PR8 | fixed QR checkout claim | PASS（local） | `terminal_checkout_claims`、device hash、nonce hash、短命claim、同一device再利用、別device競合、CAS consume、invoice version/金額変更、reissue/late paymentを実装・回帰確認。実機2台・公開運用は未確認。 |
| PR9 | kill switch / authoritative fulfillment | PASS | payment truthとfulfillment decisionを分離し、terminal/mobileはserver objectを参照。実worker/RPCは外部未確認。 |
| PR10 | app single financial writer / atomic reorg-audit-outbox | PARTIAL | production-like workerのreorg/reconciliation financial writeを署名internal APIへ集約し、API側でinvoice/transfer/review/audit/outboxをtransaction処理。worker operational stateは別SQLiteへ分離し、transaction途中・commit後・outbox lease取得後のtest-only crash fault-injectionを回帰確認。実chain worker deploymentと実環境crash証跡は未確認。 |
| PR11 | settlement preview / hard gate | PASS | daily/monthly preview・close・exportで共通hard gateを評価。実運用の対象日・block range証跡は未確認。 |
| PR12 | customer error catalog / signed receipt | PASS（local） | mobile raw error抑止、server HMAC receipt、永続immutable receipt、active/verify-only key registry、公開verify endpoint、関連テスト。production key provisioning/rotationの実運用証跡は未確認。 |
| PR13 | staff/admin separation / sticky / personal auth | PARTIAL | permission/RBAC、二者step-up、UI safetyは実装。staff/adminの完全な画面分離・個人認証運用は未確認。 |
| PR14 | policy registry / canonical docs / visual validation | PARTIAL | policy snapshot・関連docsは現行化。visual/device matrix、実iOS/Android/HashPort Wallet、外部承認は未確認。 |

## 40項目

| # | 回帰項目 | 状態 | Evidence / note |
|---:|---|---|---|
| 1 | 同じtx/log、異なるevent ID | PASS | `tests/payment-safety-logic.test.mjs`でchain id、tx hash、log indexの正規化後identityを確認。 |
| 2 | 同じtx/log、異なるRPC provider | PARTIAL | provider observationをtransferへ集約する実装あり。独立E2E未確認。 |
| 3 | 同じtx/logを別invoiceへ関連付け | PASS | `tests/payment-final-duplicate-integration.test.mjs`でtransfer 1件、observations/links 2件、両invoiceのintegrity holdを確認。 |
| 4 | paid + 新しい別tx | PASS | `tests/payment-final-duplicate-integration.test.mjs`。 |
| 5 | settled + 新しい別tx | PARTIAL | paid後監視・duplicate pathあり。settled固有の独立E2E未確認。 |
| 6 | paid + 同じtx/log再観測 | PASS | `tests/payment-confirmation-incident-lifecycle.test.mjs` の確認数更新。 |
| 7 | exact transfer + wrong-token observation | PASS | `tests/payment-safety-logic.test.mjs`。 |
| 8 | exact transfer + noncanonical observation | PASS | `tests/payment-safety-logic.test.mjs`。 |
| 9 | issued + 300 + 700 | PASS | `tests/chain-monitor.test.mjs` の split payment判定。 |
| 10 | expired状態 + 期限内block timestamp | PASS | `tests/chain-monitor.test.mjs`、`DETECTED_AFTER_EXPIRY`。 |
| 11 | 期限後block timestamp | PASS | `tests/late-arrival-review.test.mjs`、`tests/server-expiry-sweeper.test.mjs`。 |
| 12 | block timestamp欠落 | PASS | `tests/payment-safety-logic.test.mjs`、`TIMESTAMP_UNVERIFIED`。 |
| 13 | 不正block timestamp | PARTIAL | invalid timestampのfail-closed pathはあるが、独立server E2E未確認。 |
| 14 | 既存paid amount破損 | PASS | `tests/backend-p0-safety.test.mjs` のledger integrity path。 |
| 15 | display amount破損 | PASS | `tests/amounts.test.mjs`, `tests/payment-safety-logic.test.mjs`。 |
| 16 | 18→6非完全変換 | PASS | `tests/payment-safety-logic.test.mjs`, `tests/amounts.test.mjs`。 |
| 17 | review発生後に別incident発生 | PASS | `tests/payment-confirmation-incident-lifecycle.test.mjs`。 |
| 18 | paid到達時にduplicate reviewが自動解決されない | PASS | duplicate後のreview保持と確認incident限定解決を実装・テスト。 |
| 19 | adminがcanonical transferなしでpaidを作れない | PASS | canonical再検証 + `TWO_PERSON_STEP_UP_REQUIRED`、同テスト。 |
| 20 | 通常返金request時にrefunded表示にならない | PASS | `tests/refund-evidence-registry.test.mjs`、refund lifecycle実装。 |
| 21 | 別返金先signature replay | PARTIAL | challenge消費・signature hash保存実装。独立replay E2E未確認。 |
| 22 | challenge期限切れ | PARTIAL | expiry判定実装。独立期限切れE2E未確認。 |
| 23 | EIP-1271返金先承認 | PARTIAL | EIP-1271 verifier経路実装。実contract wallet証跡未確認。 |
| 24 | refund tx reorg | PARTIAL | `reorg_hold` と状態投影実装。独立reorg E2E未確認。 |
| 25 | funding sweep reorg | PARTIAL | sweep lineage / verified gate実装。独立reorg E2E未確認。 |
| 26 | address proof未確認でinvoice発行 | PASS | `tests/amount-boundaries-and-state.test.mjs`、発行hard gate。 |
| 27 | 固定QRを二端末で同時読取 | PASS（local） | `tests/fixed-terminal-qr.test.mjs`で同一invoiceの同一device再利用、別device claim競合、consume CASを確認。実物理端末2台の同時操作は未確認。 |
| 28 | claim中にinvoice version変更 | PASS（local） | `tests/fixed-terminal-qr.test.mjs`でclaim後の`invoice_version`変更を`CHECKOUT_CLAIM_STALE`として拒否。実機wallet起動直前の外部matrixは未確認。 |
| 29 | kill switch中に既存invoiceへ有効着金 | PASS | payment truthを保持しfulfillmentをholdする実装・security tests。 |
| 30 | worker heartbeat欠落 | PASS | fulfillment / settlement gateがstale heartbeatをhold。実worker停止E2E未確認。 |
| 31 | app financial transaction process crash | PASS（local） | `tests/payment-crash-fault-injection.test.mjs`でtransaction内SIGKILL後の金融行・outbox・auditのrollbackと再起動後の再処理を確認。 |
| 32 | outbox送信直前・lease取得後のcrash | PASS（local） | 同テストでcommit後pending、lease取得後`processing`、lease回収後retry/sentを確認。production-likeではtest-only failpointを起動拒否。 |
| 33 | reorg holdとauditが同時commit | PASS（local path） | `tests/chain-reconciliation-writer.test.mjs`でsigned reorg ingest後にreorg、invoice hold、payment event review、review outbox、`chain_reorg.detected` auditを同一API処理結果として確認。crash fault-injectionによるrollbackは未確認。 |
| 34 | unresolved reorgがdaily closeをblock | PASS | `evaluateSettlementHardGate` の `UNRESOLVED_CHAIN_REORGS`。 |
| 35 | dead-letterがdaily closeをblock | PASS | chain dead-letter gateとsettlement tests。 |
| 36 | raw errorが顧客画面へ出ない | PASS | `public/mobile.js` customer error catalog、`tests/frontend-mobile-safety.test.mjs`。 |
| 37 | 金額破損が0 JPYC表示にならない | PASS | strict parser / ledger integrity hold、amount tests。 |
| 38 | iPad文字サイズ200%でsticky重なりなし | PARTIAL | CSS/static contractのみ。実iPad 200% visual evidence未確認。 |
| 39 | iPad Split Viewで水平overflowなし | PARTIAL | responsive CSS/static contractのみ。実iPad Split View未確認。 |
| 40 | QRのDPR・ResizeObserver再描画 | PARTIAL | renderer再描画経路は実装。DPR/ResizeObserver実機matrix未確認。 |

## 未解決のrelease blocker

この表で `PASS` のローカル項目も、実JPYC送金・実返金Tx、HashPort Walletの実iOS/Android起動、公開FQDN/TLS、CIの最新run、digest付きrelease artifact、店舗運用訓練、法務/AML/privacy/APPI承認を代替しない。`PARTIAL` と `UNVERIFIED` が残るため、commercial GOおよび実JPYC受付開始には使用しない。
