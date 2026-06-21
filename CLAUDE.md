# CLAUDE.md — JPYC Merchant Ops / Settlement Layer

## What this repo is

Non-custodial JPYC Merchant Ops / Settlement Layer for small shops, events, and pilot deployments.
The value is **post-payment operations** — invoice-first ledger, review queue, refund evidence, daily close, audit log — not "accepting JPYC" alone.

## Non-custodial boundary (hard constraint)

Never add:

- private key custody, seed phrase handling, mnemonic handling, keystore generation
- server-side signing or refund execution
- self-onramp, self-redemption, customer asset management
- copy implying the app can buy / sell / issue / redeem / custody JPYC

## External evidence — do not falsify

These four items cannot be closed by repo-internal tests. Do not mark as PASS without real evidence:

- `EXT-001` real JPYC payment (tx hash)
- `EXT-002` real HashPort Wallet / iOS / Android launch
- `EXT-003` public FQDN + TLS + healthz/readyz/pay page
- `EXT-004` store operations drill with non-crypto staff

Source of truth for pending status: `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`

## Protected paths — do not delete without explicit approval

- `runtime/`, `data/`, `docs/production/evidence/`
- `*.db`, `*.sqlite`, `*.sqlite3`
- `.env`, `.env.production`
- `deploy/nginx/certs/`, TLS certs, audit evidence, settlement evidence

## Runtime requirement

- Node 20.x (`engines.node` in `package.json`, `.nvmrc`, `.node-version`)
- Run `npm run check && npm test && npm run test:smoke` before claiming validation passes

## Chain scope and confirmation policy

- This repo's initial operational scope is **Polygon JPYC (ERC-20)**. Do not expand chain support without approved docs.
- Do not claim "JPYC only supports Ethereum/Avalanche/Polygon". The JPYC ecosystem has expanded (e.g. Kaia-related announcements). Describe scope as "本リポジトリの初期運用スコープは Polygon" instead.
- Follow the repository confirmation policy. Current default is `REQUIRED_CONFIRMATIONS=2` / `MIN_REQUIRED_CONFIRMATIONS=2`. Do not hardcode "1 confirmation is enough".
- Commercial validation may exit 0 while the JSON verdict is `NO_GO`. Treat command exit code and business verdict separately.

## UI / UX work

- Read `DESIGN.md` before touching frontend files
- Staff language and customer language are separate; never cross-contaminate
- Do not add new frontend dependencies without explicit approval
- Use existing CSS tokens in `public/app.css`; do not hard-code new colors or spacing
- Refund copy rule: never imply the system sends refunds — always "外部ウォレットで実行した返金の証跡を登録・検証します"

## Handoff ZIP hygiene

Exclude from clean source ZIPs:

```
node_modules/  .git/  data/  runtime/  artifacts/  deliverables/  __MACOSX/  .DS_Store
.claude/settings.local.json  .claude/launch.json  .codex/
*.db  *.db-wal  *.db-shm  *.sqlite  *.sqlite3  .env  .env.production
local logs  private evidence (docs/production/evidence/*)  TLS keys
```

Build and verify with `npm run handoff:zip` (calls `npm run handoff:audit` on the staging dir). See [docs/handoff-clean-zip.md](docs/handoff-clean-zip.md).

## Key docs to read for substantial tasks

- `AGENTS.md` — accounting traceability and destructive-operation safety
- `DESIGN.md` — UI source of truth hierarchy and visual direction
- `CODEX_INSTRUCTIONS.md` — Codex working rules
- `docs/production/BLOCKED_EXTERNAL_VALIDATION.md` — external evidence tracker
- `docs/00-current-state.md` — current implementation status
