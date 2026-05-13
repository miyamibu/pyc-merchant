# 92. Real Device Validation Checklist

## Goal
実機ウォレットでの送金起動と支払い完了を、iOS / Android / 対象ウォレットごとに証跡付きで確認する。

## Device matrix
| Device | Wallet | QR読取 | 支払いページ表示 | 送金画面起動 | 送金完了後更新 | 証跡 |
|---|---|---|---|---|---|---|
| iOS | HashPort Wallet | 未実行 | 未実行 | 未実行 | 未実行 | |
| Android | HashPort Wallet | 未実行 | 未実行 | 未実行 | 未実行 | |
| iOS | WalletConnect系 | 未実行 | 未実行 | 未実行 | 未実行 | |
| Android | WalletConnect系 | 未実行 | 未実行 | 未実行 | 未実行 | |

## Execution flow
1. `npm run evidence:device:prepare` を実行して evidence ディレクトリを作る
2. `DIAGNOSTIC_MODE_ENABLED=true npm start` で端末UIを起動する
3. invoice を発行し、端末UIの診断パネルが見えている状態で各シナリオを撮影する
4. 作成された `docs/production/evidence/<timestamp>/device-validation/README.md` に証跡パスを記入する
5. このチェックリストの各 row の `証跡` 列と実施メモに同じ path を転記する

## Evidence path rule
- 保存先は `docs/production/evidence/<timestamp>/device-validation/`
- screenshot は `screenshots/device-<platform>-<wallet>-<step>.png`
- video は `videos/device-<platform>-<wallet>-<step>.mp4`
- 診断パネルは各 device / wallet ごとに最低1枚 `device-<platform>-<wallet>-diagnostics.png` を残す

## Checklist linkage memo
- iOS / HashPort Wallet:
- Android / HashPort Wallet:
- iOS / WalletConnect系:
- Android / WalletConnect系:

## Required scenarios
- QR読取
- `/pay?ref=` 表示
- `ウォレットで支払う` 押下
- deeplink / payment URI 起動
- 別チェーン時の案内
- 署名拒否時の案内
- 期限切れ時の案内
- `review_required` 表示
- 端末UIで `DIAGNOSTIC_MODE_ENABLED=true` の診断パネルを表示し、wallet payload / TTL / SSE / polling / reissue lineage をスクリーンショット保存

## Evidence
- スクリーンショット
- 画面録画
- tx hash
- 実施者
- 実施日時
