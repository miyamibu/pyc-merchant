# 63. Terminal Management

## Goal
`/terminal.html` を現場スタッフと管理者が混乱なく使える情報設計に統一する。

## UI Sections
- 端末セッション
- 請求作成
- 現在の請求 / 固定QR / 支払い状態
- provider / tap rail 提示と QR 再開
- 確認待ち支払い（管理者）
- 返金記録（管理者）
- 日次締め / CSV出力（管理者）

## Fixed QR Policy
- お客様提示用のメインQRは terminal 固定入口を表示する。
- terminal 固定入口の origin は `https://pay.miyamibu.xyz` を final URL として確定してから customer-facing QR に載せる。
- invoice 固有 URL は operator 向け参照情報として残してよいが、主導線にはしない。
- terminal は `current_invoice_id` を 1 件だけ持ち、顧客導線はその invoice に一度だけ解決される。
- same terminal で別の active invoice を同時に開始しない。
- tap rail を提示中は fixed QR からの wallet 導線を suppress し、customer-facing main panel も `かざしてください` 表示へ切り替える。

## Language Policy
- UIの主ラベルは日本語に統一する。
- 技術情報は補助説明付きで表示する。
  - 例: `返金取引番号` `返金元アドレス` `チェーンID`

## Role Separation
- スタッフ: 請求作成、状態確認、再発行
- 管理者: 確認待ち更新、返金記録、返金検証、日次締め、CSV出力
- 管理者セクションは権限ロールで表示制御する。

## Server-side Invariant
- `1 terminal = 同時に 1 件の active invoice` をサーバ側で強制する。
- 既存 active invoice が残っている状態で新規請求を作ろうとした場合、UI は「現在の会計が残っています。再発行または取消/期限切れ処理後に新規会計を開始してください」と案内する。
- reissue は旧 invoice を final / review 側へ遷移させたうえで、新しい invoice に current pointer を swap する。
- tap rail の fallback は暗黙に QR へ戻さず、staff が `QR案内へ戻す` を押した時だけ再開する。

## Provider Operator State
- terminal UI は raw provider event をそのまま見せず、`invoice.status + payment_session.status + provider_status + fulfillment_decision` から operator state を合成する。
- 主要 state:
  - `受付待ち`
  - `認証中`
  - `商品渡しOK`
  - `要再試行`
  - `要確認`
- `商品渡しOK` は fulfillment 判断であり、`paid` と同義ではない。

## Review List States
- 読み込み中
- 0件（確認待ちの支払いはありません）
- 取得失敗（再試行案内）

## Refund UX Policy
- システムが返金送金を実行するような表現をしない。
- 「外部ウォレットで実行した返金を記録・検証する」ことを明示する。

## Done when
- 返金記録と日次締めが別セクションで運用できる。
- 確認待ち一覧に loading / empty / error がある。
- 主要操作が日本語ラベルで統一されている。
