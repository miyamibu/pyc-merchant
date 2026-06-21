# 21. Chain / Token Production Policy

## Goal
本番で誤チェーン・誤トークン・不十分確認数を fail-closed で防ぐ。

## Runtime gate (production)
`APP_ENV=production` では、以下を満たさないと起動しない。

- `CHAIN_ID` is one of `1` (Ethereum Mainnet), `43114` (Avalanche C-Chain), or `137` (Polygon)
- `TOKEN_CONTRACT === APPROVED_JPYC_TOKEN_CONTRACT === 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`
- `0x431D5dfF03120AFA4bDf332c61A6e1766eF37BDB` (JPYC Prepaid/v2 context) is denylisted for funds-transfer JPYC payments.
- `JPYC_CONTRACT_APPROVAL_REF` が空でない
- `REQUIRED_CONFIRMATIONS >= MIN_REQUIRED_CONFIRMATIONS >= 1`
- `TOKEN_DECIMALS` is the ERC-20 token decimal count.
- `JPYC_BASE_UNIT_SCALE` is the internal accounting scale.
- They do not have to match, but conversions between token atomic units and app base units must be exact; non-exact transfers go to manual review/dead-letter handling.

## Required env checklist
- `CHAIN_ID`
- `TOKEN_CONTRACT`
- `APPROVED_JPYC_TOKEN_CONTRACT`
- `JPYC_CONTRACT_APPROVAL_REF`
- `TOKEN_DECIMALS`
- `JPYC_BASE_UNIT_SCALE`
- `REQUIRED_CONFIRMATIONS`
- `MIN_REQUIRED_CONFIRMATIONS`
- `CONFIRMATIONS_POLICY_APPROVAL_REF`
- `MONITOR_BACKSCAN_BLOCKS`
- `MIN_MONITOR_BACKSCAN_BLOCKS`
- `BACKSCAN_POLICY_APPROVAL_REF`

## JPYC contract verification checklist (human approval required)
1. コントラクトアドレスが Ethereum / Avalanche C-Chain / Polygon の公式公開情報と一致。
2. explorer 上で `Transfer` イベント仕様が ERC-20 と整合。
3. proxy/upgradeable の有無を確認し、運用手順に反映。
4. pause/freeze/blocklist/fee-hook 等の管理機能有無を確認。
5. 異常時（pause, blacklist）発生時の merchant 運用手順を Runbook に反映。
6. 上記確認結果を `JPYC_CONTRACT_APPROVAL_REF` に紐づく承認記録へ保存。

## Confirmation policy checklist
1. 想定 reorg 深さと downtime を基に `MIN_REQUIRED_CONFIRMATIONS` を決定。
2. `MONITOR_BACKSCAN_BLOCKS` が downtime + reorg 余裕を満たすことを確認。
3. `CONFIRMATIONS_POLICY_APPROVAL_REF` と `BACKSCAN_POLICY_APPROVAL_REF` を deployment record に紐付ける。
4. 変更時は runbook と incident 手順の再承認を行う。

## Runtime usage
- chain monitor は `APPROVED_JPYC_TOKEN_CONTRACT` と `REQUIRED_CONFIRMATIONS` を参照し、設定済みの Ethereum / Avalanche C-Chain / Polygon をチェーン別 checkpoint で監視する。
- verified manual ingest は同じ contract / confirmation policy を使う。
- refund verification も同じ contract / confirmation policy を使う。
- 未承認 contract の Transfer は `paid` / `succeeded` に昇格しない。

## Non-custodial boundary
- 本システムは private key を保持しない。
- refund/manual execution は on-chain 成功を自動保証しない。
- `manual` executor は `recorded` を返し、`succeeded` を返さない。

## Done when
- 上記 checklist の承認記録が作成され、該当 env が production に設定済み。
