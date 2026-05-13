# 43. Payment Error UX

## Goal
顧客・スタッフ・管理者がそれぞれ次の行動を即判断できるエラー文言に統一する。

## Customer Message Rules
- 短く、次の行動を必ず示す。
- 技術的な原因詳細は主表示に出さない。
- `review_required` は不安を煽らず「店舗スタッフにお声がけください」で案内する。

## Staff Message Rules
- 原因と次アクションを同時に表示する。
- 英語の内部語彙は日本語ラベルへ置換する。

## Admin Message Rules
- 取引番号、アドレス、レビューIDは表示する。
- 必要な確認先と再試行導線を表示する。

## Status-to-Action
- `expired`: 再発行を案内
- `wrong_chain` / `wrong_token`: 正しい支払い方法の再案内
- `tx_pending` / `confirming`: 二重送信を止めて待機
- `review_required`: 確認待ち支払いとして管理者処理へ

## Done when
- 顧客画面で技術語を主表示しない。
- スタッフ画面で再試行やエスカレーションの導線が明確。
- 管理者画面で必要IDを使って追跡できる。
