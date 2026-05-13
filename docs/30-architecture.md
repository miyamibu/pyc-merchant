# 30. System Architecture

## Goal
限定店舗の実証リリースに必要な論理構成と責務境界を明文化し、運用・監査・検証の前提を固定する。

## Context
- 現在のリポジトリにはアプリサーバー、監視ワーカー、店舗端末UI、公開決済ページ、監査ログ、日次締め、review queue が実装されている。
- 本文書は現行実装の責務整理であり、最新の運用判断は [`docs/00-current-state.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/00-current-state.md) と [`docs/70-infra.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/70-infra.md) を優先する。
- 実機確認、実JPYC少額決済、TLS証明書の払い出しなど外部環境依存の項目は別途検証証跡で完了判定する。

## Constraints
- ユーザー資産を預からない。
- 秘密鍵を保持しない。
- 初期スコープは Polygon 上の JPYC に限定する。
- 売上台帳の正本は invoice 単位のサーバーDBとし、端末ローカル保存を正としない。
- 送金実行は利用者ウォレット側で行い、サーバーは着金確認・照合・監査のみを担当する。

## Logical components
1. `Terminal UI`
- 店舗スタッフが請求作成、状態確認、review 対応、締め処理確認を行う操作面。
- 認証済みセッションで `/api/v1/*` を呼び出す。

2. `Public Payment Web`
- 顧客が `/pay?ref=...` からアクセスするスマホ向け公開ページ。
- `wallet_deeplink -> payment_uri -> wallet_url -> copy fallback` の順でウォレット起動を試行する。
- 支払い状態は SSE を優先し、切断時は polling fallback で追従する。

3. `App Server`
- invoice 発行、公開請求API、review queue、refund verification、CSV、監査ログ API を提供する。
- `payment_uri` などのウォレット起動 payload を生成するが、送金署名は行わない。

4. `Ledger DB`
- invoice、payment attempts、review、audit log、daily close を永続化する正本。
- SQLite を採用し、限定店舗実証向けに backup/restore drill と整合確認手順を用意する。

5. `Chain Monitor Worker`
- Polygon RPC を監視し、JPYC Transfer と invoice の照合を行う。
- 確認数、期限後着金、不足・過入金、重複支払いなどを判定して invoice 状態を更新する。

6. `Realtime Channel`
- 端末UIと公開ページへの状態通知を SSE で提供する。
- 接続断時の劣化運用として polling を許容する。

7. `Ops Layer`
- health/readiness、backup/restore、deploy preflight、ログ収集、障害時の一次切り分けを担当する。
- 本番配備は Docker Compose + reverse proxy + systemd で再現可能にする。

## Core flows
### 1. Invoice issuance
1. Terminal UI が `POST /api/v1/invoices` を実行する。
2. App Server が invoice を保存し、公開 `pay_url` とウォレット起動 payload を返す。
3. 端末UIは QR を表示し、顧客を公開ページへ誘導する。
4. 監査ログに invoice 発行イベントを記録する。

### 2. Wallet launch and payment detection
1. 顧客が `/pay?ref=...` を開く。
2. Public Payment Web が `wallet_deeplink` または `payment_uri` を使ってウォレット送金画面起動を試みる。
3. 利用者ウォレットが Polygon 上で JPYC transfer を実行する。
4. Chain Monitor Worker が着金を検知し、invoice と照合する。
5. App Server が `confirming` / `paid` / `review_required` を反映し、SSE で画面に通知する。

### 3. Exception handling
1. 期限後着金、不足・過入金、重複、誤送金疑いは `review_required` に遷移する。
2. 管理者が review queue で解消方針を決定する。
3. refund は外部実行された tx の検証のみを行い、アプリ自体は送金署名しない。
4. すべての重要操作を監査ログ hash chain に残す。

## Security boundaries
- `Wallet boundary`: 署名権限は常に利用者ウォレット側にある。
- `Server boundary`: App Server は請求、照合、監査、運用制御のみを担う。
- `Secrets boundary`: app secret、RPC URL、管理者認証情報は環境変数で注入し、repo へ保存しない。
- `Operations boundary`: TLS 終端とプロセス管理は reverse proxy / Docker / systemd 側で行う。

## Availability and operations
- `GET /healthz` はプロセス生存確認、`GET /readyz` は設定とDBの簡易確認に使う。
- deploy preflight で必須 env と起動条件を検証してから本番投入する。
- SQLite バックアップは safe backup API を使い、restore drill では別ディレクトリへ復元して整合確認する。
- ログ収集は app / worker / reverse proxy / journalctl を一括回収できるようにする。

## Non-functional targets for limited pilot
- 営業時間中の再起動復旧が手順化されていること。
- invoice 状態更新は通常 60 秒以内に反映されること。
- 監査ログ hash chain の破断が 0 件であること。
- 実証Go判定は自動テスト通過に加えて、実機・実JPYC・障害訓練の証跡で行うこと。

## Related documents
- [`docs/31-db-schema.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/31-db-schema.md)
- [`docs/32-api-spec.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/32-api-spec.md)
- [`docs/33-state-machine.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/33-state-machine.md)
- [`docs/34-idempotency-and-audit.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/34-idempotency-and-audit.md)
- [`docs/70-infra.md`](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/70-infra.md)

## Done when
- 現行のコンポーネント責務と境界が実装・運用資料と整合している。
- non-custodial 前提が明記されている。
- 実証Go判定に外部検証が必要な点が明示されている。
