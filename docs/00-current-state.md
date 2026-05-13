# 現状整理（00-current-state）: Merchant Ops / Settlement Layer

## Goal
`JPYC決済端末_MVP_UIUX` の現在地を、`JPYC小規模店舗向け non-custodial Merchant Ops / Settlement Layer` という立ち位置で、実装済み、今回追加した実証リリース準備、外部検証待ちに分けて固定する。

## Context
- 対象リポジトリ: `/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX`
- 確認日: 2026-04-22 (Asia/Tokyo)
- 対象用途: 小規模店舗・イベント・実証現場での、Polygon 上 JPYC 決済後運用

## 現状サマリー
- 本リポジトリは、静的モック段階を超え、`server + chain monitor + terminal UI + mobile payment page + audit + settlement` を持つ Merchant Ops 実装状態にある。
- ノンカストディ前提を維持し、秘密鍵保管、自前カストディ、自前オンランプは実装していない。
- 限定店舗実証リリースに必要な deployment pack と validation pack を repo 内に持つ。
- 実機ウォレット検証、実JPYC少額決済、公開TLSホスト確認は外部環境待ちであり、未実行のまま `GO` にはしない。
- プロダクトの立ち位置は `JPYC決済機能` 単体ではなく、`Merchant Ops / Settlement Layer` の実装済み土台である。特に小規模現場での例外処理と日次運用に強みがある。

## MVPステータス
| Area | Status | Notes |
|---|---|---|
| 端末セッション / 権限 | Ready | PINログイン、権限制御、セッション失効あり |
| 請求発行 | Ready | invoice-first ledger、署名付き `/pay?ref=` 発行 |
| 顧客支払いページ | Ready | mobile page、残り時間、状態更新、copy fallback あり |
| ウォレット送金導線 | Repo-internal ready / external evidence pending | `payment_uri`、template-based deeplink、手動送金 fallback を返す。実機起動証跡は未充足 |
| オンチェーン検知 | Repo-internal ready / real-payment evidence pending | chain monitor、dead-letter、checkpoint あり。実JPYC証跡は未充足 |
| review queue / refund verify | Ready | 不足/過入金/重複/期限後着金を `review_required` へ送る |
| 監査ログ | Ready | hash chain verify あり |
| 日次締め / CSV / export | Ready | unresolved review を含む締め処理あり |
| 本番配備 | Repo-internal ready / public-host evidence pending | Docker / compose / systemd / nginx / backup / restore / healthcheck |
| 実機 / 実JPYC証跡 | External pending | `docs/production/BLOCKED_EXTERNAL_VALIDATION.md` で管理 |

## 実装済み
- APIサーバー、SQLite台帳、chain monitor worker、terminal / mobile UI が動作する。
- `payment_url` は署名付き `/pay?ref=` を使い、顧客ページへ誘導する。
- 公開請求APIは `payment_uri`、`wallet_deeplink`、`wallet_url`、`wallet_help_url`、copy fallback を返す。
- terminal は `review / refund / settlement / monitor` を優先順で示す compact ops summary を備える。
- review 詳細は reason_type ごとの次アクションと返金候補額を即表示し、返金フォームへ下書き反映できる。
- `expired -> paid` は許可せず、期限後着金は `review_required` に送る。
- verified manual ingest と refund verification は on-chain transfer の整合確認を前提にしている。
- audit log は hash chain で整合検証できる。
- `/healthz`、`/readyz`、`/metrics` があり、運用監視と approval gate を確認できる。

## 今回追加したもの
- 実ウォレット送金導線:
  - EIP-681 の ERC-20 transfer URI 生成
  - template-based wallet deeplink
  - `wallet_deeplink -> payment_uri -> wallet_url -> copy fallback` の起動順
- 本番デプロイ構成:
  - `Dockerfile`
  - `docker-compose.prod.yml`
  - `deploy/systemd/*`
  - `deploy/nginx/*`
  - `scripts/deploy/*`
- 実運用証跡パッケージ:
  - `scripts/production-validation/*`
  - `docs/production/evidence/*`
  - `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`

## 外部検証待ち
- HashPort Wallet 実機での送金画面起動確認
- iOS / Android の QR 読取と支払い完了確認
- 実JPYC少額決済と tx hash 証跡
- 公開TLSホストでの `/healthz` / `/readyz` / `/pay?ref=` 確認
- 限定店舗スタッフによる締め処理と incident drill

## 限定店舗実証リリースに向けた残課題
- 実機ウォレット証跡を埋める
- 実JPYC少額決済を行い tx hash ledger を残す
- `.env.production`、TLS証明書、公開ホストを準備する
- 対象店舗・対象端末・運用責任者を minutes に固定する

## スケール上の次論点
- 現行は SQLite を前提とした限定店舗実証向け構成である。
- 広域営業展開では PostgreSQL などへの移行、複数店舗同時負荷、運用SLA強化を次フェーズで扱う。

## Validation
- `npm run check`
- `npm test`
- `npm run audit`
- `npm run test:smoke`
- `npm run test:audit-chain`
- `npm run deploy:check`
- `PRODUCTION_EVIDENCE_ROOT="$(mktemp -d)" npm run production:validate`

## Done when
- 限定店舗実証リリース直前の実態を、誇張なく説明できる。
- 実装済みと外部 pending が混ざらずに読める。
