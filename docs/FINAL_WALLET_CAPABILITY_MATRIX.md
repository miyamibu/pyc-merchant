# Final Wallet Capability Matrix

| Capability | Current implementation | Device-tested | Result |
|---|---:|---:|---|
| HashPort deeplink | Config-driven deeplink template | no | pending |
| EIP-681 URI | yes | no | pending |
| WalletConnect transaction session | no | no | not_implemented |
| Manual copy fallback | yes | no | pending |

## Notes

- Reown Project ID presence alone is not accepted as WalletConnect readiness.
- WalletConnect is not displayed as supported unless transaction-session implementation is explicitly enabled.
- Wallet signing and transaction approval remain human-only actions.
