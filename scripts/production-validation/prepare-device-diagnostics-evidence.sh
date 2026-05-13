#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
EVIDENCE_DIR="${1:-./docs/production/evidence/${TIMESTAMP}}"
DEVICE_DIR="${EVIDENCE_DIR}/device-validation"
SCREENSHOT_DIR="${DEVICE_DIR}/screenshots"
VIDEO_DIR="${DEVICE_DIR}/videos"
NOTES_FILE="${DEVICE_DIR}/README.md"

mkdir -p "$SCREENSHOT_DIR" "$VIDEO_DIR"

cat > "$NOTES_FILE" <<EOF
# Device Validation Evidence

- Timestamp (UTC): ${TIMESTAMP}
- Checklist reference: [docs/92-real-device-validation-checklist.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/92-real-device-validation-checklist.md)
- Required runtime flag: \`DIAGNOSTIC_MODE_ENABLED=true\`

## Goal
実機検証時に、支払いページの挙動と診断パネルの両方を同じ evidence bundle に保存する。

## Capture order
1. \`DIAGNOSTIC_MODE_ENABLED=true npm start\` で端末UIを起動する
2. 対象 invoice を発行し、端末UIの診断パネルが表示されていることを確認する
3. 各 device / wallet ごとに以下を撮影する
   - QR読取後の \`/pay?ref=\` 表示
   - \`ウォレットで支払う\` 押下前後
   - wallet deeplink / payment URI 起動結果
   - 診断パネル
   - 支払い完了後または review_required / expiry 画面

## Naming convention
- screenshots: \`device-<platform>-<wallet>-<step>.png\`
- videos: \`device-<platform>-<wallet>-<step>.mp4\`

Examples:
- \`device-ios-hashport-pay-page.png\`
- \`device-ios-hashport-diagnostics.png\`
- \`device-android-hashport-wallet-launch.mp4\`
- \`device-ios-walletconnect-review-required.png\`

## Checklist linkage
以下の evidence path を [docs/92-real-device-validation-checklist.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/92-real-device-validation-checklist.md) の各 row / 実施メモに転記する。

- iOS / HashPort Wallet:
- Android / HashPort Wallet:
- iOS / WalletConnect系:
- Android / WalletConnect系:

## Diagnostics screenshot minimum
診断パネルのスクリーンショットには、少なくとも以下が同一画面内に見えていること。
- \`payment_uri\`
- \`wallet_deeplink\`
- \`wallet_url\`
- wallet adapter status / reason
- \`supported_wallets\`
- \`chain_id\` / \`network\` / \`token_symbol\` / \`token_contract\` / \`token_decimals\`
- \`receive_address\`
- \`expected_amount_atomic\`
- \`pay_url\`
- invoice status
- \`expires_at\` / TTL
- SSE / polling fallback
- \`copy_fallback\`
- reissue lineage

## Operator notes
- 実施者:
- 実施日時:
- 端末 build / branch:
- 備考:
EOF

printf '%s\n' "$DEVICE_DIR"
