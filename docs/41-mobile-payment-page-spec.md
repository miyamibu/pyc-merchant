# 41. Mobile Payment Page Spec

## Goal
`/mobile.html` を、暗号資産に詳しくない顧客でも迷わず支払える `invoice 固定` の画面にする。

## Entry Flow
1. お客様は terminal 固定 QR (`/t/:publicEntryToken`) を読む。
2. current invoice がある場合だけ signed `/pay?ref=...` に解決する。
3. current invoice がない場合は `/terminal-entry.html` で待機させる。
4. 一度 `/mobile.html?invoiceId=...&exp=...&nonce=...&sig=...` に入った後は、その invoice に固定する。

`/mobile.html` は「現在の terminal 状態を追いかけるページ」ではなく、「解決済み invoice の支払いページ」である。

## First View Information Priority
1. 店舗名
2. 請求金額
3. 支払い期限と残り時間
4. 現在の支払い状態
5. メインCTA `ウォレットで支払う`

## CTA
- メインCTA: `ウォレットで支払う`
- サブCTA: `支払い方法を見る`
- サブCTA: `支払い情報をコピー`
- ウォレット連携URLがない場合は手動送金案内に切り替える。

## Technical Details Placement
以下は主表示ではなく、詳細折りたたみ内に置く。
- 支払いネットワーク
- 支払い通貨
- 支払い先アドレス
- 請求ID
- 取引番号（支払い後）

## Status Copy
- `pending/open/issued`: 支払いをお待ちしています
- `payment_detected/confirming`: 支払いを確認中です
- `paid`: 支払いを確認しました
- `settled`: 支払いは確定済みです
- `review_required`: 支払いに確認が必要です。店舗スタッフにお声がけください
- `expired`: この請求は期限切れです。店舗スタッフに再発行を依頼してください
- `cancelled`: この請求は無効です

## Trust and Safety Copy
- お客様のウォレットから直接送金されることを明示する。
- 秘密鍵・シードフレーズを入力しないことを明示する。
- 支払い状況が自動更新されることを明示する。

## Accessibility
- 状態更新は `aria-live` で通知する。
- CTA とコピー操作は 44px 以上のタップ領域を維持する。
- フォーカス表示を常時有効にする。

## Done when
- 顧客主画面で技術語が主見出しにならない。
- `ウォレットで支払う` CTA が常に表示される。
- 技術情報は詳細折りたたみで確認できる。
- 秘密鍵やシードフレーズの入力欄が存在しない。
- fixed QR から来た場合でも、この画面は単一 invoice に固定される。
