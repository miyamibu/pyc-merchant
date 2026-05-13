# 81. Implementation Plan Snapshot

## Goal
限定店舗の実証リリースに向けた実装フェーズを、完了済みの土台と残る外部作業に分けて整理する。

## Context
- コア実装は完了済みで、現在は「基礎実装」ではなく「最後の実務ピース」を詰める段階にある。
- 今回の仕上げで、ウォレット起動導線、本番配備パック、検証証跡パック、外向け資料更新を追加した。
- 実機・実JPYC・本番ホスト投入は人間側の外部作業として残る。

## Constraints
- non-custodial を崩さない。
- 秘密鍵や本番秘密情報を repo に保存しない。
- 未実行の外部検証を完了扱いにしない。

## Completed implementation slices
1. `Core app`
- invoice 発行、台帳、監査ログ、review queue、refund verification、日次締め

2. `Wallet launch`
- EIP-681 payment URI
- deeplink template 展開
- public invoice API の wallet payload
- mobile manual fallback UI

3. `Production pack`
- Dockerfile
- docker-compose.prod.yml
- systemd service
- nginx config
- healthcheck / preflight / backup / restore drill / log collection

4. `Validation pack`
- production validation scripts
- evidence 保存先
- limited release / device / incident / closing checklist

5. `External docs`
- current state
- executive summary
- infra
- production validation plan

## Remaining external work
1. 実機ウォレット検証
2. 実JPYC少額決済
3. 本番証明書配置と本番サーバ投入
4. 店舗スタッフ訓練と Go/No-Go サインオフ

## Done when
- リポジトリ内で完了できる実装・スクリプト・資料が揃っている。
- 外部作業が evidence ベースで消化できる状態になっている。
