# AGENTS.md

## Goal
Guide Codex work in this repository so accounting traceability and destructive-operation safety remain first-class.

## Context
- This repository is a non-custodial JPYC Merchant Ops / Settlement Layer.
- The product's differentiator is post-payment operations: settlement, review, refund evidence, audit, and accounting traceability.
- `daily close` and `export_reference` already exist. The next accounting step is a stable, versioned settlement export contract.
- MVP accounting outputs are generic CSV and JSON. `freee`, `マネーフォワード`, `弥生`, and direct API syncs are downstream adapters, not the source of truth.
- The source of truth for business state is the server-side ledger, not terminal-local state, wallet state, or vendor adapter output.

## Constraints
- Do not custody assets, private keys, seed phrases, mnemonics, keystores, or signing authority.
- Do not implement server-side signing, refund execution, custody, wallet recovery, or user asset management unless explicitly approved as a separate architecture change.
- Before implementing vendor-specific accounting sync, define or update `Settlement Export Contract v1` and its schema/tests.
- Treat the settlement export contract as the source of truth. Adapters must not redefine ledger semantics.
- Preserve traceability from `export_reference` to settlement, invoice, checkout session, payment, review, refund, audit, and external sync references.
- Do not hard-delete business records. Prefer status transitions, archive, void, cancel, or soft-delete style fields.
- Do not delete files, folders, records, or data without explicit user approval, unless the deletion is limited to a clearly safe exception listed in this file.
- Any business-impacting archive, cancel, delete, or restore behavior must leave audit evidence and respect separated permissions and approvals.
- If a change affects settlement export fields, meanings, formats, or validation rules, update the contract docs and contract tests in the same change.
- If accounting requirements are ambiguous, do not invent new ledger semantics. Ask for clarification before implementation.

## UI / UX work
- For UI/UX tasks, read `DESIGN.md` before editing code and keep long repeatable procedures in `.agents/skills/`.
- Source of truth priority: current explicit user instruction, existing code/components/design tokens, `DESIGN.md`, approved Figma/design files, screenshots or `gpt-image-2` images, then ambiguous natural-language preferences.
- Do not implement directly from generated images or screenshots. First convert the visual reference into an implementation brief covering layout, components, tokens, states, responsive behavior, accessibility, risks, and validation.
- If `gpt-image-2` images are generated or received for UI direction, show the options, summarize strengths/risks, and wait for explicit user approval before implementation.
- Do not add new UI, icon, animation, CSS framework, font, or design-token dependencies without explicit approval.
- Do not commit, push, deploy, or alter production-facing configuration without explicit approval.
- For substantial UI changes, state the validation plan and save available evidence under `artifacts/ui-review/YYYY-MM-DD/`.

## Settlement Export Contract v1
Maintain the settlement export contract in:

- `docs/contracts/settlement-export-v1.md`
- `docs/contracts/settlement-export-v1.schema.json`
- `tests/accounting/settlement-export-contract.test.mjs`

If these files do not exist yet, create them before implementing accounting sync behavior.

The contract must remain adapter-agnostic. Vendor-specific exports and API syncs may transform contract data, but must not redefine invoice, payment, refund, review, settlement, or audit semantics.

At minimum, settlement export behavior must preserve traceability for:

- `export_reference`
- settlement identity
- business date
- invoice identity
- checkout session identity
- payment attempt / transfer evidence
- review status and reason
- refund case and refund evidence
- audit log references
- external sync references, when present

## Destructive operations policy
Business records and audit/settlement evidence must never be hard-deleted.

Hard delete includes, but is not limited to:

- deleting business rows with SQL `DELETE`
- `DROP TABLE`
- `TRUNCATE`
- deleting or removing invoices, payment attempts, payment events, payment sessions, review cases, refunds, settlements, settlement exports, accounting sync records, reconciliation links, audit logs, or address pool records
- deleting or removing production evidence, source files, docs, migrations, or tests
- deleting data needed to reconstruct accounting or audit history
- deleting data needed to explain invoice status, refund status, review decisions, settlement exports, or `export_reference`

Before deleting any file, folder, record, or data, Codex must ask the user for explicit approval unless the operation is clearly covered by a safe cleanup exception.

### Protected paths and protected data
The following paths and data are protected and must not be modified, removed, reset, truncated, or used as cleanup targets without explicit user approval:

- `runtime/`
- `data/`
- `docs/production/evidence/`
- `.env`
- `.env.production`
- `deploy/nginx/certs/`
- `*.db`
- `*.sqlite`
- `*.sqlite3`
- runtime DB files, backups, recovery artifacts, production validation evidence, and TLS certificates

Protected business data includes at least:

- invoices
- payment attempts and payment evidence
- review cases
- refund requests and refund evidence
- settlements and settlement export snapshots
- accounting sync records
- audit logs
- any traceability data needed to explain invoice/payment/refund/review/settlement/accounting state

### Safe cleanup exceptions
Safe cleanup exceptions must be narrow, explicit, and non-business-impacting.

The following may be cleaned up only when clearly safe or explicitly approved:

- temporary files created during the current task
- generated build artifacts created during the current task
- isolated test-only fixtures
- isolated temporary test databases
- expired non-business runtime records such as:
  - `idempotency_records`
  - `service_replay_guards`
  - `rate_limit_events`

Safe cleanup exceptions do not apply to:

- business records
- audit evidence
- settlement evidence
- production validation evidence
- source files
- documentation
- migrations
- tests
- runtime DB
- backups
- `.env` files
- TLS certificates

Prefer status transitions, archive, void, cancel, or soft-delete-style fields over hard delete.

Any business-impacting archive, cancel, void, restore, or delete behavior must leave audit evidence and respect separated permissions and approvals.

If deletion approval is missing, Codex must not proceed.

If auditability and implementation convenience conflict, Codex must choose auditability.

## Accounting sync and adapter rules
Generic CSV and JSON exports are the MVP accounting outputs.

Vendor-specific integrations are downstream adapters. This includes:

- `freee`
- `マネーフォワード`
- `弥生`
- direct accounting API syncs

Adapters may map or transform settlement export data into vendor-specific formats. They must not:

- redefine invoice semantics
- redefine payment semantics
- redefine refund semantics
- hide manual review state
- drop auditability
- create external sync records without preserving internal traceability
- treat vendor output as the source of truth

If implementing accounting sync history, preserve at least:

- sync status
- external system name
- external reference
- exported/synced timestamp
- retry count
- last error
- item-level failure evidence, when applicable

## Permission and approval rules
Business-impacting destructive actions must respect separated permissions and approvals.

When adding delete, archive, restore, cancel, void, refund, settlement, or accounting sync behavior, consider whether the implementation needs separate permissions such as:

- `data.delete.request`
- `data.delete.approve`
- `data.archive`
- `data.restore`
- `accounting.export.create`
- `accounting.export.view`
- `accounting.sync.create`
- `accounting.sync.retry`
- `accounting.sync.view`

Do not allow implementation convenience to bypass approval, role separation, or audit evidence.

## Done when
- Changes preserve the non-custodial boundary.
- Accounting outputs remain versioned, auditable, and adapter-agnostic.
- `export_reference` remains traceable to settlement, invoice, payment, review, refund, audit, and external sync references.
- No destructive change is introduced without explicit approval and auditability.
- Business records are preserved through state transitions rather than hard delete.
- Safe cleanup exceptions remain narrow and non-business-impacting.

## Output format
For every completed Codex task, include the following sections:

### Settlement export contract impacted
State one of:

- `yes`
- `no`

If `yes`, summarize:

- contract changes
- schema changes
- code changes
- tests updated or added

### Destructive behavior
State one of:

- `none`
- `archive`
- `cancel`
- `void`
- `soft delete`
- `hard delete`
- `safe cleanup exception`

If a deletion or destructive operation was considered but not performed, state that explicitly.

### Files changed
List the files changed.

### Protected data touched
State `yes` or `no`.

If `yes`, identify the protected path or business data that was touched and why it was explicitly approved.

### Tests / validation
State what was run or why validation was not run.

### Auditability
State how traceability, auditability, or non-custodial boundaries were preserved.

## Validation method
- Run or update contract tests for settlement export fields, types, and traceability when export behavior changes.
- Verify `export_reference` can still be traced to settlement, invoice, payment, review, refund, and audit records when settlement/accounting behavior changes.
- Reject changes that add hard delete without explicit approval.
- Reject changes that modify accounting semantics without updating the contract docs and tests.
- Run `npm run security:destructive` for policy and static guardrail changes when possible.
- For policy-only documentation changes, inspect the final diff and ensure no source, test, migration, evidence, or runtime file was changed.

## Failure-handling behavior
- If accounting requirements are ambiguous, stop and ask before inventing new ledger semantics.
- If deletion approval is missing, do not proceed with the destructive step.
- If auditability and implementation convenience conflict, choose auditability.
- If a requested change would weaken the non-custodial boundary, stop and explain the risk.
- If a requested change would make settlement exports vendor-specific before the generic contract exists, stop and define the generic contract first.
- If a safe cleanup exception is not clearly safe, ask for approval before proceeding.
