# JPYC Token Metadata Pin Report

- Status: `CANDIDATE_NOT_APPROVED`
- Captured at: 2026-08-26T02:48:31Z
- Chain: Polygon PoS mainnet
- Chain ID: `137`
- Token contract: `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`
- Token name: `JPY Coin`
- Token symbol: `JPYC`
- Token decimals: `18`

## Result

Two independent public Polygon RPC providers returned the same token metadata,
ERC-1967 implementation address, token runtime code hash, and implementation
runtime code hash. PolygonScan's verified proxy constructor identifies the same
implementation address.

This report records technically observed candidate pins only. It does not claim
that either hash has received the required technology-owner approval, release
binding, expiry, or signature. Production validation must remain fail-closed
until the approval payload is signed and the approved values are supplied
through the protected production environment.

## Observed candidate pins

| Field | Observed value |
|---|---|
| Proxy kind | `ERC1967` |
| ERC-1967 implementation slot | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` |
| Implementation address | `0xafac17fc3936a29ca2d2787ced3c5d1c52007d2e` |
| Token runtime byte length | `811` |
| Token runtime code hash | `0xed040fe509076fecc53768e957b9b52a3b3fba907d9d0ed4dc029c86ec3e904e` |
| Implementation runtime byte length | `20019` |
| Implementation runtime code hash | `0xe79ee627372f287ed4c10739504509aa22e6445c3ca0eb83fdacc98ba57394b2` |

## Independent RPC observations

| Endpoint ID | Block | Block hash | Required-field agreement |
|---|---:|---|---|
| `polygon-dcloud` | `92671655` | `0x016c9d84ee075c611a7cab3bd7fff95255b77daa41f70a1303a809d6c83485a0` | PASS |
| `polygon-publicnode` | `92671656` | `0x30524f2e184287585058dc24419c74d417df7d8eb9584de78cf4d86ba2f9fbc6` | PASS |

The endpoints were queried one block apart. Agreement is asserted only for
chain ID, token contract, name, symbol, decimals, proxy kind, implementation
address, token runtime hash, and implementation runtime hash. The block number
and block hash are expected to differ.

The complete RPC capture, including both exact runtime bytecodes and storage
words, is stored as permission-0600 operational evidence outside Git:

`/Users/mimac/Documents/Codex/2026-08-26/jpyc-production-go-sites/20260826T021255Z/TOKEN_METADATA_PIN.rpc.json`

## Primary and explorer sources

- JPYC Inc. official warning identifying the Polygon 137 contract:
  <https://corporate.jpyc.co.jp/news/posts/Notice>
- JPYC official GitHub organization contract table:
  <https://github.com/jpycoin>
- Polygon official public RPC endpoint list:
  <https://docs.polygon.technology/pos/reference/rpc-endpoints>
- PolygonScan verified proxy:
  <https://polygonscan.com/address/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29>

## Approval gate

Before setting `REQUIRE_TOKEN_METADATA_PINS=true` in a real-money environment,
the approval payload in `TOKEN_METADATA_PIN_APPROVAL_PAYLOAD.json` must be
bound to an exact release identity and signed by the designated approver. A
calculated hash, this report, a passing RPC comparison, or a chat authorization
is not a substitute for the repository's signed approval gate.
