# JPYC小規模店舗向け Merchant Ops / Settlement Layer 実証リリース要約（02-executive-summary）

## Goal
店舗、補助金申請、協力先が、「このプロダクトは決済アプリ単体ではなく、決済後運用を担う Merchant Ops / Settlement Layer である」と短時間で判断できるようにする。

## 何を提供するか
- 店舗スタッフが暗号資産の細部を知らなくても、JPYC決済の受付だけでなく、着金確認、manual review、返金記録、日次締め、監査ログ確認まで回せる。
- terminal には、未解決レビュー、返金候補、本日日次締め、dead-letter を優先順で示す compact ops summary がある。
- review 詳細では reason_type ごとの次アクションを表示し、返金フォームへの下書き補助までつなぐ。
- 顧客には署名付き `/pay?ref=` から支払いページを提供し、ウォレット起動、手動送金 fallback、状態自動更新を行う。
- 運用側には invoice-first ledger、review queue、CSV / export、監査 hash chain、health / readiness / metrics、deployment pack、validation pack を提供する。

## どのレイヤーを取りに行くか
- 本プロジェクトの立ち位置は `決済手段` そのものではなく、`Merchant Ops / Settlement Layer` である。
- 店舗にとっての価値は `JPYCで払えること` ではなく、`支払い後の照合、例外処理、返金、締め、証跡保存まで迷わず回せること` にある。
- そのため、競合比較では `加盟店網` や `円転機能` よりも、invoice-first と audit-first の運用レイヤーを前面に出す。

## 非カストディ境界
- 利用者資産は預からない。
- 秘密鍵を生成・保存・預からない。
- 送金は利用者ウォレット側で実行する。
- 返金も外部実行 tx を記録・検証する方式で、サーバーが署名しない。

## 現在の完成度
- コア実装:
  - terminal login / invoice issuance / mobile payment page / chain monitoring / review / refund verify / settlement / audit は実装済み。
- 実証リリース準備:
  - wallet launch payload、Docker / compose / systemd / nginx、backup / restore drill scripts、production validation scripts を整備済み。
- 自動品質:
  - `check`, `test`, `audit`, `smoke`, `audit-chain` を通す前提で運用できる。

## まだ未実行のもの
- 実機 HashPort Wallet / iOS / Android での送金画面起動確認
- 実JPYC少額決済の tx hash 証跡
- 公開TLSホスト上での最終確認
- 対象店舗スタッフによる締め処理・incident drill

## 重要な伝え方
- 「検証済み」と言えるのは、repo 内の自動テストとローカル validation pack まで。
- 実機・実JPYC・本番ホストが必要な項目は、未実行なら未実行と明記する。
- ただし、未実行項目を実行可能にする deployment pack / validation pack / evidence directory は整備済み。

## 限定店舗実証に向く理由
- Polygon 上の JPYC に限定しているため、初期範囲が明確。
- invoice 単位で売上照合でき、過入金・不足入金・重複・期限後着金を review へ送れる。
- ノンカストディのため、利用者資産をサーバーが保持しない。
- 限定店舗向けの Go/No-Go 判定と証跡保存の導線がある。

## 小規模チームならではの強み
- 小規模店舗、イベント、実証導入のような限定現場に合わせて、review 理由、返金運用、スタッフ導線を素早く改善できる。
- 大手の標準化より先に、現場の `困りごと` に合わせた調整を入れやすい。
- したがって初期戦略は、広く浅くではなく `少数の現場で深く運用を成立させること` を優先する。

## 次の Go 条件
1. 実機ウォレット起動証跡
2. 実JPYC少額決済証跡
3. TLSホストでの公開確認
4. 限定店舗の運用訓練証跡

## Done when
- 店舗、補助金、協力先に対して、現在地を正確かつ前向きに説明できる。
