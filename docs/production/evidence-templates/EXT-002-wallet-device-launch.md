# EXT-002 Wallet Device Launch

- status: pending
- wallet_name: HashPort Wallet
- hashport_wallet_ios_status: pending
- hashport_wallet_android_status: pending
- copy_fallback_status: pending
- app_version:
- device_model:
- os_version:
- pay_url:
- wallet_launch_result:
- normal_payment_result:
- expired_payment_result:
- overpayment_result:
- underpayment_result:
- duplicate_payment_result:
- screenshot_ref:
- diagnostic_screenshot_ref:
- tester:
- checked_at:
- run_command: `npm run evidence:device:prepare`

## Goal
HashPort Wallet 実機(iOS/Android)で、起動・支払い・コピーfallbackを確認する。

## Constraints
Tier-1 fail は Commercial Go 不可。

## Done when
iOS/Android/copy_fallback が全て pass。
