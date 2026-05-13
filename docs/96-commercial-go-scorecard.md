# Commercial Go Scorecard

## Goal
商用判定で使う gate 名、canonical env key、validation path、判定名を固定し、repo 内の truth を 1 つに揃える。

## Context
- `docs/production/evidence/20260421T163407Z/SUMMARY.md` は production validation pack `PASS`。
- latest canonical `docs/production/evidence/20260427T233711Z/COMMERCIAL_GO_SUMMARY.md` は商用判定 `NO_GO`。
- 現在の repo の論点は「未実装」ではなく「implemented core に対する commercial closeout」である。

## Canonical gate map
| Gate | Canonical key / artifact | Canonical validation path | Canonical doc ref |
|---|---|---|---|
| Production env | `APP_ENV`, `APP_HOST`, `PAY_BASE_URL`, `PUBLIC_BASE_URL`, `APP_SECRET`, `SERVICE_INGEST_SECRET`, `METRICS_SECRET` | `npm run deploy:check`, `npm run production:validate:env` | `README.md`, `docs/71-production-deployment.md` |
| Commercial mode | `COMMERCIAL_GO_MODE`, `SETTLEMENT_UNRESOLVED_REVIEW_POLICY` | `npm run commercial:validate`, `GET /readyz` | `docs/commercial/commercial-go-runbook.md` |
| Legal / AML / Privacy / APPI | `LEGAL_*`, `AML_*`, `PRIVACY_*`, `APPI_*` | `npm run commercial:validate`, `GET /readyz` | `docs/80-approval-plan.md`, `docs/92-legal-aml-appi-runtime-gates.md` |
| JPYC contract gate | `CHAIN_ID`, `TOKEN_CONTRACT`, `APPROVED_JPYC_TOKEN_CONTRACT`, `TOKEN_DECIMALS`, `JPYC_BASE_UNIT_SCALE`, `JPYC_CONTRACT_APPROVAL_REF` | `node scripts/production-validation/validate-production-config.mjs`, `npm run commercial:validate` | `docs/21-chain-and-token-spec.md` |
| Confirmation / backscan policy | `REQUIRED_CONFIRMATIONS`, `MIN_REQUIRED_CONFIRMATIONS`, `CONFIRMATIONS_POLICY_APPROVAL_REF`, `MONITOR_BACKSCAN_BLOCKS`, `MIN_MONITOR_BACKSCAN_BLOCKS`, `BACKSCAN_POLICY_APPROVAL_REF` | production startup fail-closed, `GET /readyz`, `npm run commercial:validate` | `docs/21-chain-and-token-spec.md` |
| Policy URL readiness | `public/mobile.js` の `POLICY_URLS.terms/privacy/refund`（public HTTPS URL） | `npm run commercial:validate` | `docs/legal/customer-consent-requirements.md`, `docs/production/BLOCKED_EXTERNAL_VALIDATION.md` |
| Dangerous flags | `WALLET_ADAPTER_TYPE`, `ENABLE_PUBLIC_PAYMENT_SIMULATION`, `DEMO_CONTROLS_ENABLED`, `DIAGNOSTIC_MODE_*`, `ALLOW_MANUAL_PAYMENT_INGEST`, `MANUAL_INGEST_APPROVAL_REF`, `CORS_ALLOW_ORIGINS`, `TRUST_PROXY` | production startup fail-closed, `npm run commercial:validate` | `README.md`, `docs/75-security-design.md` |
| EXT evidence | `EXT-001..004` markdown evidence | `npm run evidence:external:prepare`, `npm run commercial:validate` | `docs/production/BLOCKED_EXTERNAL_VALIDATION.md` |
| POC package | `POC-001..003` markdown evidence, KPI scorecard, signed minutes | `npm run evidence:external:prepare`, `npm run commercial:validate` | `docs/commercial/phase1-poc-playbook.md` |

## Output contract
- `commercial-go-validation.json`
- `commercial-go-scorecard.md`
- `COMMERCIAL_GO_SUMMARY.md`

上記 3 点は同じ validation output dir に揃える。
generated scorecard は validation output dir に保存する。

## Verdict rules
- `NO_GO`
  P0 blocker が 1 件でもある。
- `CONDITIONAL_NO_GO_FOR_COMMERCIAL`
  P0=0 だが P1 または P2 が残っている。repo は fail-closed のまま据え置き、商用開始はしない。
- `COMMERCIAL_GO`
  P0=0 かつ production/commercial gate と `EXT-001..004` がすべて pass。
- `COMMERCIAL_GO_10`
  `COMMERCIAL_GO` に加えて `POC-001..003` KPI evidence もすべて pass。

## Usage
- 既定: `npm run commercial:validate`
- safe 出力先固定: `npm run commercial:validate:safe`
- repo を汚さない一時実行: `COMMERCIAL_EVIDENCE_ROOT="$(mktemp -d)" npm run commercial:validate`
- scorecard のみ再生成: `node scripts/production-validation/validate-commercial-scorecard.mjs --input <commercial-go-validation.json>`
- external / POC template seed: `npm run evidence:external:prepare`

## Constraints
- external pending を pass 扱いしない。
- machine verdict 名を docs 上で言い換えてずらさない。
- generated output を source-of-truth docs の代わりに commit しない。

## Done when
- gate の判定軸が固定されている。
- generated scorecard の保存先が validation output dir に統一されている。
- `NO_GO` / `CONDITIONAL_NO_GO_FOR_COMMERCIAL` / `COMMERCIAL_GO` / `COMMERCIAL_GO_10` の意味が docs とコードで一致している。
