# Codex Repo-Internal Closeout Polish Prompt

## Issue Map
- P0 code fixes are already believed complete, but must be re-verified against live code before any further edits.
- Repo-internal closeout is not the same thing as external commercial closeout; this prompt covers only repo-side finishing work.
- Remaining repo-side work is expected to be mostly documentation alignment, validation hardening, terminology cleanup, and test/verification strengthening.
- Protected evidence paths exist; improve closeout hygiene without editing protected evidence files unless explicit approval is provided.
- Some candidate work items are scope-dependent (`accounting adapters`, `provider/tap real integration`) and must not be silently pulled into MVP scope.

## Goal
As Codex, complete the remaining **repo-internal** closeout and polish work for this repository without touching external approvals, real payment execution, real device verification, public TLS rollout, or other human-only actions.

The target outcome is:

1. repo-internal status is described accurately and consistently
2. closeout/approval documentation is internally coherent
3. commercial validation can be re-run safely without writing into protected evidence paths
4. production-readiness gaps that are still repo-internal are either fixed or explicitly documented
5. scope-dependent future work is clearly separated from MVP-done claims

## Context
Repository root:

`/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX`

This repository is a non-custodial JPYC Merchant Ops / Settlement Layer. The server-side ledger and audit evidence are the operational source of truth. External pending items must remain honest and must not be converted into fake pass states.

Known current repo state from prior verification:

- The four previously reported code findings are believed fixed.
- `npm run check`, `npm test`, and `npm run security:destructive` are believed green.
- A safe `commercial:validate` run into `artifacts/` is believed to match the latest canonical `COMMERCIAL_GO_SUMMARY.md`.
- Main remaining work is likely repo-internal polish rather than new core payment logic.

Primary references to read first:

- `AGENTS.md`
- `CODEX_INSTRUCTIONS.md`
- `docs/prompts/codex-remediation-and-readiness-prompt.md`
- `docs/98-completion-status-internal-share.md`
- `docs/82-execution-roadmap.md`
- `docs/95-mvp-done-evidence-matrix.md`
- `docs/87-go-no-go-evidence-matrix.md`
- `docs/91-go-no-go-checklist.md`
- `docs/80-approval-plan.md`
- `docs/92-legal-aml-appi-runtime-gates.md`
- `docs/61-secret-management.md`
- `docs/legal/customer-consent-requirements.md`
- `docs/33-state-machine.md`
- latest canonical `docs/production/evidence/<timestamp>/COMMERCIAL_GO_SUMMARY.md`

Code and config areas likely involved:

- `src/server.mjs`
- `public/mobile.js`
- `package.json`
- `scripts/production-validation/*`
- `tests/**/*.test.mjs`

## Scope
This prompt is intentionally limited to **repo-internal** work. That includes:

- documentation accuracy and consistency
- non-protected closeout hygiene docs
- validation script hardening
- status/term normalization
- repo-local regression coverage improvements
- safe automation wrappers

This prompt does **not** include:

- legal conclusions
- approval ref issuance
- real tx execution
- real wallet/device validation
- public domain/TLS rollout
- store drill execution
- writing to `docs/production/evidence/` or other protected paths without explicit approval

## Constraints
- Work only inside `/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX`.
- Re-verify the current live repo state before editing. Do not trust prior summaries blindly.
- Before editing, run `git status --short`. If there are unexpected user changes in files you need to touch, stop and report.
- Keep diffs minimal and focused on repo-internal closeout polish.
- Do not edit protected paths/data without explicit user approval:
  - `runtime/`
  - `data/`
  - `docs/production/evidence/`
  - `.env`
  - `.env.production`
  - `deploy/nginx/certs/`
  - `*.db`
  - `*.sqlite*`
- Read-only inspection of protected evidence is allowed.
- Do not fabricate approval refs, signatures, tx hashes, public URLs, secret values, screenshots, or pass results.
- Do not weaken the non-custodial boundary.
- Do not silently expand MVP scope to include vendor accounting adapters or real provider/tap integrations unless the current repo explicitly treats them as required in-scope work.
- For browser/E2E strengthening, prefer the smallest maintainable solution. Do not add large new dependencies unless strongly justified and documented.

## Tasks

### 1. Re-baseline the repo
Run:

```sh
pwd
git status --short
```

Then re-open the current live versions of:

- `docs/98-completion-status-internal-share.md`
- `docs/82-execution-roadmap.md`
- `docs/95-mvp-done-evidence-matrix.md`
- `docs/61-secret-management.md`
- `docs/legal/customer-consent-requirements.md`
- `public/mobile.js`
- `src/server.mjs`
- `package.json`

Produce a short issue map of repo-internal unfinished items before editing.

### 2. Tighten repo-internal status wording
Update repo-side status/closeout docs so they do **not** overclaim that “everything except external is complete” if repo-internal polish work still remains.

At minimum:

- make `docs/98-completion-status-internal-share.md` precise about:
  - P0 fixes complete
  - external blockers incomplete
  - repo-internal polish/validation/hygiene items still remaining, if they truly remain
- keep `docs/82-execution-roadmap.md` aligned with the current implemented-core reality
- avoid contradictions between `docs/82`, `docs/95`, `docs/98`, and the latest commercial verdict

### 3. Improve repo-internal closeout hygiene without editing protected evidence
Because `docs/production/evidence/` is protected, do **not** edit the pending evidence files there unless explicitly approved.

Instead, improve the non-protected repo-side management docs so that pending external evidence is managed cleanly.

Examples of acceptable repo-side improvements:

- clarify in non-protected docs that pending evidence must include:
  - blocker reason
  - owner
  - next action
  - due date or planned slot
- point readers to the canonical pending templates/process without pretending the current protected evidence files are complete
- update action-packet or closeout docs outside protected paths if that improves hygiene

### 4. Add a safe commercial validation path
If not already present, add a safe repo-local way to run commercial validation without writing into `docs/production/evidence/`.

Preferred outcome:

- a script entry such as `commercial:validate:safe`
- or a small wrapper under `scripts/production-validation/`

Behavior:

- write output under `artifacts/commercial-validate/<timestamp>/`
- read canonical evidence from `docs/production/evidence/`
- avoid modifying protected evidence paths

Update docs/tests as needed.

### 5. Decide and implement the narrowest safe policy-URL guard
Assess whether empty/draft `POLICY_URLS` should remain only a docs warning or should be represented in repo-side readiness/validation.

Implement the **narrowest safe** repo-side improvement that:

- does not require real public URLs today
- preserves local/dev usability
- makes commercial-readiness truth more explicit

Preferred approaches:

- static validation in `commercial:validate`
- a readiness/check output field
- a docs-backed validator rule

Avoid introducing brittle runtime coupling unless clearly necessary.

### 6. Normalize state terminology
Clarify the status naming around:

- `review_required`
- `manual_review`

Goals:

- preserve backward compatibility where needed
- make one term clearly canonical
- align docs/UI/shareable language so non-engineers are not confused

This may involve:

- docs clarifications
- comments or mapping cleanup
- copy normalization
- tests that protect the intended compatibility behavior

### 7. Strengthen repo-local flow verification
Add repo-local verification coverage for the critical staff/customer flow that is still missing.

You are not required to introduce full Playwright if that is too heavy. Choose the smallest credible solution.

Possible acceptable outcomes:

- lightweight browser-flow regression coverage
- HTML/JS behavior checks expanded in current suites
- a minimal smoke/E2E harness with existing tooling

The goal is to strengthen confidence in:

- staff invoice creation
- customer consent gate
- customer payment action availability
- status rendering
- closeout/readiness surface behavior

If you decide not to add a new dependency, explicitly justify the chosen lighter approach.

### 8. Clean up repo-side closeout docs and guards
Make any other small repo-internal improvements that are clearly supported by current evidence, such as:

- updating `docs/61-secret-management.md` to include `METRICS_SECRET`
- refreshing stale references to older canonical verdict timestamps in non-protected docs
- clarifying that generic CSV/JSON export is MVP-complete while vendor adapters remain out-of-scope or future work
- clarifying provider/tap real integration scope if the current repo wording leaves that ambiguous

Do not invent new scope. Only clarify the current one.

### 9. Re-run safe validation
Run:

```sh
npm run check
npm test
npm run security:destructive
```

If you implemented a safe commercial validation path, run it and compare its output against the latest canonical `COMMERCIAL_GO_SUMMARY.md`.

If browser/E2E coverage was added, run that too.

## Output Format
Use this exact final report structure:

### 1. Repo-Internal Work Completed
- file
- line reference when relevant
- what changed
- why it was needed

### 2. Repo-Internal Items Still Open
- item
- why still open
- whether it is:
  - `repo polish`
  - `scope decision`
  - `external-only`

### 3. Validation Results
- command
- pass/fail
- actual observed counts where applicable
- if something was intentionally not run, say why

### 4. Scope Clarifications
- accounting export vs accounting adapters
- QR-only MVP vs provider/tap real integration
- canonical status naming
- policy URL handling

### 5. Final Repo-Internal Verdict
- `Repo-internal P0 implementation: complete / incomplete`
- `Repo-internal closeout polish: complete / incomplete`
- `External production readiness: still blocked / unblocked`

### 6. AGENTS-Aligned Section
Include exactly:

- `Settlement export contract impacted: yes/no`
- `Destructive behavior: none/archive/cancel/void/soft delete/hard delete/safe cleanup exception`
- `Files changed`
- `Protected data touched: yes/no`
- `Tests / validation`
- `Auditability`

## Validation Method
- Re-open live files before editing to verify what is already true.
- Confirm any doc-status claim against the current repo, not an old dump.
- Run `npm run check`.
- Run `npm test`.
- Run `npm run security:destructive`.
- If you add a safe commercial validation path, run it into `artifacts/` and compare with the latest canonical verdict.
- Ensure no protected evidence path was modified.

## Failure-Handling Behavior
- If a proposed improvement requires editing protected evidence paths, stop and report rather than editing them.
- If a scope question cannot be resolved from current repo docs, document the ambiguity instead of inventing a new product scope.
- If browser/E2E strengthening would require disproportionate dependency bloat, choose the lightest defensible improvement and explain it.
- If a status/wording conflict is discovered between docs, fix the non-protected docs that are clearly stale and note any remaining ambiguity.
- If validation fails, fix only repo-internal issues in scope and then re-run the relevant checks.

## Done When
- Repo-internal status wording is accurate and not overstated.
- Safe commercial validation can be run without writing into protected evidence paths.
- Repo-side closeout hygiene is improved without touching protected evidence.
- Policy URL handling is clarified and, if appropriate, guarded in repo-side validation/readiness.
- Status naming is clearer and documented.
- Repo-local verification coverage is stronger than before.
- Any remaining work is clearly labeled as repo polish, scope decision, or external-only.
