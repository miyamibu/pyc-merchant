# Codex Remediation And Readiness Prompt

## Issue Map
- Repo-internal remediation: verify the four known findings against live code, then fix only what is still unresolved without broad refactors.
- Regression safety: prove each fix with focused tests, then run the full safe validation suite.
- Action-file audit: re-read the legal, external-validation, contract, deploy, and evidence-control files instead of trusting a prior report.
- Final verdict separation: distinguish `コードとして運用準備OK` from `外部アクション込み本番GO`.
- External-pending honesty: never convert legal/external/ops blockers into `pass` or `GO` without real evidence.

## Goal
As Codex, execute the known repo-internal fixes, verify them, audit the remaining action files/data, and produce a final readiness verdict that cleanly separates:

1. code/config/test readiness inside the repository
2. real-world production readiness including legal, device, payment, TLS, and signoff dependencies

The end result must be trustworthy enough that a human owner can use it as the authoritative repo-side closeout record.

## Context
Repository root:

`/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX`

This repository is a non-custodial JPYC Merchant Ops / Settlement Layer. The server-side ledger and audit evidence are the source of truth. Repo-local validation does not replace external evidence.

Known repo-internal findings to address:

1. `src/server.mjs`: `/api/v1/invoices/:invoiceId/cancel` lacks an explicit permission guard
2. `src/server.mjs`: `/api/v1/invoices/:invoiceId/expire` lacks an explicit permission guard
3. `public/mobile.js`: consent gating does not fully cover detailed copy actions
4. `src/settlement-export.mjs`: `buildDailyAccountingSummary` does not aggregate `cancelled`

Canonical references to use:

- `AGENTS.md`
- `CODEX_INSTRUCTIONS.md`
- `docs/60-auth-and-permissions.md`
- `docs/33-state-machine.md`
- `docs/contracts/settlement-export-v1.md`
- `docs/contracts/settlement-export-v1.schema.json`
- `docs/35-settlement-export-contract-v1.md`
- `docs/80-approval-plan.md`
- `docs/85-gate-decision-book.md`
- `docs/87-go-no-go-evidence-matrix.md`
- `docs/91-go-no-go-checklist.md`
- `docs/92-legal-aml-appi-runtime-gates.md`
- `docs/open-questions.md`
- `docs/11-regulatory-questions.md`
- `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`
- latest available `docs/production/evidence/<timestamp>/COMMERCIAL_GO_SUMMARY.md`

Treat any prior report as a hint only. Re-open the current files, re-run safe validation, and correct any stale claim, missing file, drifted line number, or outdated test count.

## Constraints
- Work only inside `/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX`.
- Do not trust previous summaries without checking the live repository state.
- Before editing, run `git status --short`. If you see unexpected user changes in files you need to touch, stop and report instead of overwriting them.
- If the four fixes are already present in live code, do not churn those files. Verify them, normalize tests only if needed, and continue to validation and readiness audit.
- Keep diffs minimal. Fix only what is required to resolve the four findings plus the smallest necessary test coverage updates.
- Prefer updating existing relevant test suites over creating a one-off test file. If a new dedicated test file is genuinely cleaner, explain why.
- If you create a temporary standalone test file during this task, migrate the coverage into existing suites before finalizing when practical. Delete only the self-created temporary file, and only if that cleanup clearly fits the safe cleanup exception.
- Do not modify or delete protected paths/data without explicit user approval:
  - `runtime/`
  - `data/`
  - `docs/production/evidence/`
  - `.env`
  - `.env.production`
  - `deploy/nginx/certs/`
  - `*.db`
  - `*.sqlite*`
- Read-only inspection of protected evidence/docs is allowed; writing is not.
- Do not fabricate tx hashes, legal conclusions, approval refs, public URLs, screenshots, signatures, secret values, or production pass states.
- Do not weaken non-custodial boundaries. Never add private-key handling, server-side signing, custody, refund execution, or wallet recovery.
- Do not run real-payment, device, public-TLS, deployment, or evidence-writing scripts unless the user explicitly asks and provides the required environment.
- If `git` metadata is unavailable or unreliable, say so explicitly and continue using file inspection plus validation commands.
- Use exact file/line references in the final report, and use absolute paths when referring to repository files.

## Tasks

### 1. Baseline the current state
Run:

```sh
pwd
git status --short
```

Then inspect the current target files with exact line numbers before editing:

- `src/server.mjs`
- `public/mobile.js`
- `src/settlement-export.mjs`
- relevant tests under `tests/`

First determine which of the four findings are:

- already fixed in live code
- still unresolved
- fixed in code but weakly tested

State the fix plan in one short table before changing code.

### 2. Implement the minimal safe fixes
Apply the smallest change set that resolves the four findings that are still unresolved:

- In `src/server.mjs`, add the appropriate permission guard to:
  - `/api/v1/invoices/:invoiceId/cancel`
  - `/api/v1/invoices/:invoiceId/expire`
- Choose the permission model that best matches current repo design. If `reissue` already establishes the intended precedent, follow it.
- In `public/mobile.js`, ensure both UI state and handler logic enforce consent for:
  - `copyAddress`
  - `copyAmount`
  - `copyInvoice`
- In `src/settlement-export.mjs`, make `buildDailyAccountingSummary` aggregate `cancelled` consistently with the contract/schema/docs.

### 3. Add or update targeted tests
Add focused coverage that proves the fixes, ideally in existing suites:

- auth/permission coverage for `cancel` and `expire`
- consent-gating coverage for detailed copy actions
- settlement summary coverage for `cancelled`

Each finding must map to at least one concrete test assertion.

Preferred test placement:

- route/permission behavior in existing server integration tests
- frontend consent/static guard behavior in existing frontend security tests
- settlement summary behavior in existing accounting contract/export tests

If an ad hoc dedicated test file already exists for these findings, migrate the assertions into the most relevant existing suites unless there is a clear reason not to.

### 4. Run safe validation
Run these safe repo-local commands:

```sh
npm run check
npm test
npm run security:destructive
```

If a narrower targeted test command exists and helps faster iteration, you may run it before the full suite, but the full suite must still run before final reporting.

If `package.json` exposes `commercial:validate`, run it only in a way that avoids writing into protected evidence paths. Use an output directory outside `docs/production/evidence/`, for example:

```sh
mkdir -p artifacts/commercial-validate
npm run commercial:validate -- --output-dir artifacts/commercial-validate/<timestamp>
```

You may let it read canonical evidence from `docs/production/evidence/`, but do not let it write there during this task.

### 5. Audit the action files and status files
Read and report the state of the following without editing protected evidence:

- `docs/80-approval-plan.md`
- `docs/85-gate-decision-book.md`
- `docs/87-go-no-go-evidence-matrix.md`
- `docs/91-go-no-go-checklist.md`
- `docs/92-legal-aml-appi-runtime-gates.md`
- `docs/open-questions.md`
- `docs/11-regulatory-questions.md`
- `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`
- `docs/contracts/settlement-export-v1.md`
- `docs/contracts/settlement-export-v1.schema.json`
- `docs/35-settlement-export-contract-v1.md`
- `scripts/production-validation/*`
- `scripts/deploy/*`
- `scripts/security/check-destructive-ops.mjs`
- relevant `tests/**/*.test.mjs`

Also inspect the latest available commercial verdict by timestamp:

- identify the lexicographically latest `docs/production/evidence/<timestamp>/COMMERCIAL_GO_SUMMARY.md`
- identify the immediately previous verdict file as well when available
- confirm whether its conclusion is still consistent with `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`
- confirm whether the latest and previous verdict materially agree on verdict/blockers
- if multiple evidence directories disagree, report the mismatch instead of silently choosing one

### 6. Produce the final A/B verdict
You must separate:

- Verdict A: `コード/設定/テスト観点での運用準備`
- Verdict B: `外部アクション込み本番運用`

`Verdict A` may be `Go` only if the four findings are truly resolved and the safe validation suite passes.

`Verdict B` must remain `No-Go` if required legal approvals, env references, external evidence, public host checks, or multi-owner signoff are still missing.

For external blockers, list exact blocker IDs and exact env var names when known, but never print secret values.

If you ran a fresh safe `commercial:validate` into a non-protected output directory, compare that fresh result against:

- the latest canonical `COMMERCIAL_GO_SUMMARY.md`
- `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`

If they diverge, report the divergence explicitly.

## Output Format
Use this exact report structure:

### 1. 実装サマリー
- file
- line reference
- what changed
- why it was the minimal safe fix

### 2. 未解決指摘の解消状況
For each finding `F1..F4`:
- `resolved` or `unresolved`
- exact evidence with absolute file path and line number
- test that now covers it

### 3. テスト / 検証結果
- command
- `pass` or `fail`
- short result summary
- if failed, the exact blocker and whether it is repo-internal or external
- if passed, include the actual observed test count instead of copying an old count

### 4. 行動ファイル / データ確認結果
For each target file or file group:
- `確認済`
- `不在`
- `外部待ち`
- one-line impact note

### 5. 最終運用判定
- `判定A（コード運用可否）: Go / No-Go`
- `判定B（外部込み本番可否）: Go / No-Go`
- blocker list with IDs, owners when inferable, and next concrete step

### 6. AGENTS準拠セクション
Include exactly:

- `Settlement export contract impacted: yes/no`
- `Destructive behavior: none/archive/cancel/void/soft delete/hard delete/safe cleanup exception`
- `Files changed`
- `Protected data touched: yes/no`
- `Tests / validation`
- `Auditability`

## Validation Method
- Re-open the live code first and verify whether each of the four findings is already fixed before making edits.
- Re-open the changed files after editing and confirm the expected lines are present.
- Confirm each finding has at least one corresponding test assertion.
- Run `npm run check`.
- Run `npm test`.
- Run `npm run security:destructive`.
- If available, run `npm run commercial:validate -- --output-dir <non-protected-path>` and capture its fresh verdict without writing into `docs/production/evidence/`.
- For the readiness section, compare the latest commercial verdict file against `docs/production/BLOCKED_EXTERNAL_VALIDATION.md` and the approval/gate docs.
- If external required items remain pending, keep the final production verdict blocked even when repo-local tests pass.

## Failure-Handling Behavior
- If the repo contains unexpected unrelated changes in target files, stop before editing and report the conflict.
- If `git status --short` is clearly unreliable in this environment, say so explicitly and use direct file inspection plus command validation as the evidence basis.
- If a claimed reference file does not exist, say so explicitly and continue with the repo as source of truth.
- If a line number moved after edits, report the new exact line number instead of repeating stale references.
- If tests fail, distinguish repo-internal regressions from environment/external blockers and fix only the repo-internal issues that are in scope.
- If `commercial:validate` would write into a protected path by default, override only its output location; do not skip noting this behavior.
- If approval, payment, device, TLS, or signoff evidence is missing, do not simulate it; keep the item pending and state the next human action.
- If the code is clean but production evidence is incomplete, say `判定A = Go` and `判定B = No-Go`.

## Done When
- All four known findings are verified against live code and either fixed with evidence/tests or explicitly reported as already fixed or still unresolved.
- The full safe validation suite has been run and reported.
- Any fresh `commercial:validate` run used a non-protected output directory and its verdict was compared with the canonical evidence summary.
- The action-file audit has been completed from current repo contents, not copied from a previous summary.
- The latest commercial verdict has been cross-checked against the canonical external-blocker file.
- The final answer clearly separates repo readiness from real-world production readiness.
- No protected data, secrets, or fabricated evidence were written.
