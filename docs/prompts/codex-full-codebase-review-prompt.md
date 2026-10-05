# Codex Full Codebase Review Prompt

## Goal
Review the JPYC payment terminal repository end to end as Codex, with special attention to payment correctness, security, auditability, non-custodial boundaries, destructive-operation safety, and settlement export traceability.

Produce actionable review findings only when they are supported by code evidence. The purpose is not to rewrite the code during review; it is to identify concrete risks, missing tests, behavioral regressions, and commercial Go blockers.

## Context
Repository root:

`/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX`

This repository is a non-custodial JPYC Merchant Ops / Settlement Layer. The operational source of truth is the server-side ledger and audit evidence, not terminal-local state, wallet state, provider raw output, or accounting adapter output.

Core product boundaries:

- Non-custodial: the server must not hold private keys, seed phrases, mnemonics, keystores, or signing authority.
- Refunds: human/external wallet execution first, then `tx_hash` recording and verification. Do not propose server-side signing as a fix.
- Auditability: business-impacting state changes must be traceable through audit logs and should preserve hash-chain verifiability.
- Signed public payment URL: customer-facing invoice/payment/consent APIs must verify signed invoice URL parameters where required by the current route design.
- Fail-closed production gates: Legal / AML / Privacy / APPI approval gates and approval references must block unsafe production operation when incomplete.
- Terminal invariant: a terminal should not create or expose multiple active invoices at the same time.
- Address-pool invariant: payment collection must preserve the intended one invoice / one receive-address accounting trace where applicable.
- Settlement export: the adapter-agnostic `Settlement Export Contract v1` is the accounting snapshot contract. Vendor adapters must not redefine ledger semantics.
- Destructive-operation policy: business records and audit/settlement evidence must not be hard-deleted without explicit approval and auditability.

Primary reference files:

- `AGENTS.md`
- `CODEX_INSTRUCTIONS.md`
- `docs/33-state-machine.md`
- `docs/contracts/settlement-export-v1.md`
- `docs/contracts/settlement-export-v1.schema.json`
- `docs/35-settlement-export-contract-v1.md`
- `docs/60-auth-and-permissions.md`
- `docs/62-refund-policy-and-flow.md`
- `docs/80-approval-plan.md`
- `docs/85-gate-decision-book.md`
- `docs/87-go-no-go-evidence-matrix.md`
- `docs/91-go-no-go-checklist.md`
- `docs/92-legal-aml-appi-runtime-gates.md`
- `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`

## Review Scope
Read every target file in full. Do not rely only on `rg` matches or summaries. Use `nl -ba`, `sed -n`, or editor inspection so line references are exact.

Before detailed review, run these read-only orientation commands:

```sh
pwd
git status --short
rg --files src public scripts tests docs/contracts docs/prompts | sort
wc -l src/server.mjs src/chain-monitor.mjs src/payment-logic.mjs src/amounts.mjs public/mobile.js public/terminal.js public/index.js public/terminal-entry.js src/settlement-export.mjs src/wallet-adapter.mjs src/payment-rails.mjs src/provider-rail.mjs src/reason-codes.mjs scripts/verify-audit-chain.mjs scripts/security/check-destructive-ops.mjs scripts/smoke-test.mjs
```

If file names or line counts differ from the list below, use the repo as source of truth and note the difference.

### Tier 1: Payment Core
1. `src/server.mjs`
2. `src/chain-monitor.mjs`
3. `src/payment-logic.mjs`
4. `src/amounts.mjs`

### Tier 2: Frontend
5. `public/mobile.js`
6. `public/terminal.js`
7. `public/index.js`
8. `public/terminal-entry.js`
9. `public/mobile.html`
10. `public/terminal.html`
11. `public/terminal-entry.html`
12. `public/app.css`

### Tier 3: Domain Modules
13. `src/settlement-export.mjs`
14. `src/wallet-adapter.mjs`
15. `src/payment-rails.mjs`
16. `src/provider-rail.mjs`
17. `src/reason-codes.mjs`

### Tier 4: Scripts And Guardrails
18. `scripts/verify-audit-chain.mjs`
19. `scripts/security/check-destructive-ops.mjs`
20. `scripts/smoke-test.mjs`
21. `scripts/production-validation/*.mjs`
22. `scripts/production-validation/*.sh`
23. `scripts/deploy/*.sh`

### Tier 5: Tests And Contract Coverage
24. `tests/**/*.test.mjs`
25. `tests/helpers/*.mjs`
26. `tests/accounting/settlement-export-contract.test.mjs`

## Constraints
- Review only unless the user explicitly asks you to patch code.
- Do not edit source, docs, evidence, env files, runtime data, databases, backups, certs, or tests during the review.
- Do not run the app server, chain monitor, production deployment scripts, real payment scripts, Docker deployment, or anything that may write to protected paths.
- Do not touch `.env`, `.env.production`, `runtime/`, `data/`, `docs/production/evidence/`, `deploy/nginx/certs/`, `*.db`, `*.sqlite`, or `*.sqlite3`.
- Do not fabricate legal conclusions, approval refs, tx hashes, real device evidence, TLS evidence, screenshots, signatures, or Go verdicts.
- Do not recommend custodial fixes, server-side signing, private-key storage, seed phrase handling, wallet recovery, or hidden asset management.
- Do not mark speculative issues as `HIGH`. Use `HIGH` only when the exploit, data corruption, accounting break, or commercial blocker is directly supported by code.
- Treat tests as evidence, but do not treat the presence of a test as proof if the test does not assert the exact invariant.
- If a suspected issue depends on external legal judgment, report it as an open question or commercial blocker, not as a code defect.
- If a finding affects settlement export semantics, explicitly say whether contract docs/schema/tests must change.

## What To Check
### Security And Access Control
- SQL injection: all dynamic SQL values must use parameter binding. Pay special attention to dynamic table/column/order fragments.
- Command injection: user-controlled input must not reach shell commands, deploy scripts, or child processes unsafely.
- Authentication and authorization: admin/staff routes must use the correct `requirePermission()` or equivalent guard.
- Permission separation: archive, restore, cancel, void, refund, settlement, export, sync, and destructive-like actions must respect role separation.
- Public APIs: rate limiting and signed URL verification must match the intended endpoint category. Do not assume every public endpoint uses the same auth path; compare route intent to docs and tests.
- Replay/idempotency: retries and duplicate requests must not double-count payments, settlements, refunds, or audit events.
- Secret hygiene: no production secret values, weak defaults, or logged secrets should be present.
- CSP/XSS: frontend DOM writes should use `textContent` for untrusted text; any `innerHTML` usage must be proven safe.
- CORS/trust proxy/session cookies: production defaults should be fail-closed and consistent with docs.

### Payment Correctness
- Amount conversion: `toBaseUnits()` / `fromBaseUnits()` and display formatting must be consistent around decimals, rounding, atomic units, and JPYC base-unit scale.
- Invoice states must match `docs/33-state-machine.md`.
- `paid` must require chain/provider evidence appropriate to the rail. Provider accepted/captured must not silently become on-chain paid.
- Underpayment, overpayment, duplicate payment, wrong token, wrong chain, wrong recipient, reorg, late arrival, and expired invoice paths must route to the correct review or terminal state.
- Reissue behavior must preserve traceability for old invoices/addresses/events and must not create ambiguous active invoices.
- Address pool exhaustion must fail predictably and not reuse addresses unsafely.
- Kill switch behavior must cover global, store, and terminal scopes.

### Non-Custodial Boundary
- Search for signing, private-key, seed, mnemonic, keystore, wallet recovery, custody, transfer execution, and refund execution behavior.
- Confirm refund execution does not make the server a signer/custodian.
- Confirm any `external_signer` / `custody_provider` behavior is blocked by legal gates and does not silently become default commercial behavior.

### Auditability And Destructive Safety
- Every business-impacting state transition should have audit evidence.
- Audit hash-chain calculation and verification must agree.
- Audit export must respect privacy/APPI gates.
- Business records should use status transitions, archive, void, cancel, or soft-delete-style fields instead of hard delete.
- `check-destructive-ops.mjs` must detect protected `DELETE`, `DROP TABLE`, `TRUNCATE`, and unsafe cleanup patterns while allowing only documented safe cleanup exceptions.
- Expired cleanup for non-business runtime tables must be narrow and guarded.

### Settlement Export Contract
- `src/settlement-export.mjs` and settlement export routes must match:
  - `docs/contracts/settlement-export-v1.md`
  - `docs/contracts/settlement-export-v1.schema.json`
  - `docs/35-settlement-export-contract-v1.md`
  - `tests/accounting/settlement-export-contract.test.mjs`
- Preserve traceability from `export_reference` to settlement, invoice, checkout session, payment evidence, review, refund, audit, and external sync references.
- Ensure provider raw payload/status does not leak into canonical export fields.
- Ensure `provider accepted/captured != paid` remains true.
- Ensure personal/private artifacts remain export-excluded.

### Frontend And UX Safety
- `state.consented` must gate wallet launch, copy payment info, and receipt-related actions as intended.
- `POLICY_URLS` empty fallback must not be mistaken for production readiness.
- SSE and polling fallback must not create runaway timers, duplicate subscriptions, stale invoice display, or memory leaks.
- QR generation must use local assets where required and must not depend on unavailable third-party CDN paths.
- Frontend status labels must not claim final payment success before backend evidence says so.
- Error states should guide staff/customer without exposing secrets or private operational data.

### Tests And Missing Coverage
- Map findings to existing tests. Identify whether a failing invariant is already covered, weakly covered, or untested.
- Check tests for happy-path bias around payment, refund, audit, settlement export, destructive operations, and production gates.
- Call out missing tests that would have caught each `HIGH` or `MEDIUM` finding.

## Suggested Search Aids
Use these only as navigation aids; still read the relevant code in full around each match.

```sh
rg -n "requirePermission|verifySig|isPublicRateLimited|audit\\(|idempotent|DELETE FROM|DROP TABLE|TRUNCATE|privateKey|mnemonic|seed|keystore|signer|custody|external_signer|POLICY_URLS|innerHTML|toBaseUnits|fromBaseUnits|TERMINAL_ACTIVE_INVOICE_EXISTS|export_reference|Settlement Export|provider_receivable|accepted|captured" src public scripts tests docs -S
rg -n "app\\.(get|post|patch|delete)\\(" src/server.mjs
rg -n "describe\\(|test\\(" tests -S
```

## Optional Validation
Default review mode is static reading. If the user explicitly allows validation, run only safe local checks:

```sh
npm run check
npm test
```

Do not run scripts that require real JPYC transfer, real devices, production env, Docker deployment, public TLS, or protected runtime data unless the user explicitly asks and provides the required environment.

## Output Format
Lead with findings, ordered by severity. If there are no findings, state that explicitly and list residual risks/test gaps.

For each finding, include:

```md
### [HIGH|MEDIUM|LOW] Short Title
- File: /absolute/path/to/file:line
- Evidence: short code reference or <=25-word quote
- Problem: what is wrong
- Risk: concrete impact
- Fix: smallest safe change
- Test: focused test or validation to add/run
- Commercial Go impact: yes/no/unknown
- Settlement export contract impacted: yes/no
```

When running inside the Codex desktop app, also emit one inline review directive per actionable finding:

```text
::code-comment{title="[P1] Short title" body="One-paragraph explanation with risk and minimal fix." file="/absolute/path/to/file" start=123 end=123 priority=1 confidence=0.85}
```

Priority mapping:

- `P0`: critical security, custody boundary break, irreversible accounting corruption, or production hard-delete risk.
- `P1`: high-confidence commercial blocker, auth bypass, payment misclassification, audit-chain break, or settlement export semantic break.
- `P2`: meaningful bug, missing guard, missing test, or operational risk that should be fixed before broad rollout.
- `P3`: maintainability issue, weak diagnostics, or low-risk hardening.

After findings, include:

```md
## Summary
- HIGH:
- MEDIUM:
- LOW:
- Commercial Go impact:
- Settlement export contract impacted:
- Destructive behavior concerns:
- Non-custodial boundary concerns:
- Tests reviewed:
- Tests not run:

## Open Questions
- ...

## Files Reviewed
- /absolute/path...
```

## Done When
- Every target file in scope has been read or explicitly listed as unavailable with the reason.
- Findings are grounded in exact file/line evidence.
- The review distinguishes confirmed defects from open questions.
- Commercial Go impact is stated honestly and does not override external pending requirements.
- Non-custodial boundaries are preserved in every recommendation.
- Settlement export contract impact is identified when relevant.
- Destructive-operation risks are called out without performing destructive actions.

## Failure-Handling Behavior
- If a file is too large for one pass, review it in numbered line chunks and keep a progress checklist.
- If context becomes tight, finish the current tier and produce a clear continuation plan with reviewed/unreviewed files.
- If a suspected issue lacks evidence, downgrade it to an open question or request targeted follow-up.
- If a requested fix would require legal/accounting semantics, stop at the review finding and ask for human clarification before proposing implementation details.
- If validation cannot be run safely, say why and continue with static review.
- If the repo has unrelated dirty changes, do not revert them; mention only if they affect review confidence.
