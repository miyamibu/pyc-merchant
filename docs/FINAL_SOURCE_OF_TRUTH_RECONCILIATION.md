# Final Source Of Truth Reconciliation

Generated for release evidence ID `20260619T053216Z`.

## Chain Scope

- Ecosystem-known capability catalog remains Ethereum Mainnet `1`, Avalanche C-Chain `43114`, and Polygon `137`.
- Deployment-enabled scope for this closeout is `ENABLED_PAYMENT_CHAIN_IDS=137`.
- `CHAIN_ID=137` remains the default/fallback chain, not a substitute for the deployment allowlist.

## Contract

- Funds-transfer JPYC contract: `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`.
- JPYC Prepaid/v2 denylist: `0x431D5dfF03120AFA4bDf332c61A6e1766eF37BDB`.
- Release-time RPC/explorer metadata remains pending until approved Polygon RPC and human approval evidence are supplied.

## Decimals

- `TOKEN_DECIMALS=18` is the ERC-20 token atomic-unit decimal count.
- `JPYC_BASE_UNIT_SCALE=1000000` is the app accounting scale.
- Old `TOKEN_DECIMALS=6` references are treated as stale documentation, not runtime truth.

## Confirmations

- Current default is `REQUIRED_CONFIRMATIONS=2` and `MIN_REQUIRED_CONFIRMATIONS=2`.
- Per-chain policy is introduced as a closeout requirement but remains pending where live approval refs and RPC evidence are absent.

## Wallet Capabilities

- `hashport_deeplink`, `eip681_uri`, `walletconnect_transaction_session`, and `manual_copy_fallback` are separate capabilities.
- `WALLET_ADAPTER_TYPE=reown` plus Project ID is not evidence of WalletConnect transaction-session support.
- WalletConnect transaction session remains `not_implemented` unless `WALLETCONNECT_TRANSACTION_SESSION_IMPLEMENTED=true` is explicitly set by an approved implementation.

## Gate Interpretation

- `commercial:validate:safe` exit code is not a business GO signal.
- The JSON verdict remains the source of truth. The current validation result is `NO_GO`.
