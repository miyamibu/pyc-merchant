# 99. Data Protection Policy

## Goal
Add a permanent project rule that prevents Codex, AI coding agents, and developers from deleting important business data, audit evidence, settlement evidence, runtime artifacts, or recovery material without explicit approval.

## Context
- This repository is a non-custodial JPYC Merchant Ops / Settlement Layer.
- The product's value depends on invoice-first ledger integrity, manual review traceability, refund evidence, daily close, audit logs, and accounting traceability.
- Runtime data, backups, `.env` files, and certificates may be outside Git recovery paths and must be protected accordingly.

## Protected paths
The following paths are protected and must not be modified or deleted without explicit user approval:

- `runtime/`
- `data/`
- `docs/production/evidence/`
- `.env`
- `.env.production`
- `deploy/nginx/certs/`
- `*.db`
- `*.sqlite`
- `*.sqlite3`

Codex must not modify `runtime/`, `data/`, `.env*`, certs, or production evidence without explicit approval.

## Protected business entities
Protected business entities and records include at least:

- invoices
- payment attempts and payment evidence
- review cases
- refund requests and refund evidence
- settlements and settlement export snapshots
- accounting sync history
- audit logs
- address pool records
- any traceability data required to explain invoice, payment, review, refund, settlement, or export outcomes

## Safe cleanup exceptions
Safe cleanup exceptions must remain narrow and explicit:

- temporary files created during the current task
- generated build artifacts created during the current task
- isolated test-only fixtures
- isolated temporary test databases
- expired non-business runtime records such as `idempotency_records`, `service_replay_guards`, and `rate_limit_events`

These exceptions do not allow deleting business records, audit evidence, settlement evidence, production validation evidence, source files, documentation, migrations, tests, runtime DBs, backups, `.env` files, or TLS certificates.

## Approval requirements
- Hard delete includes SQL `DELETE` against business records, `DROP TABLE`, `TRUNCATE`, or removing files/data needed to reconstruct accounting or audit history.
- Required approval comes before deleting, moving, or resetting files, folders, records, or evidence.
- If approval is missing, Codex must not proceed.
- If auditability and convenience conflict, choose auditability.
- Prefer archive, void, cancel, restore, or soft-delete-style transitions over hard delete.
- Business-impacting archive/cancel/void/restore/delete flows must leave audit evidence and respect separated permissions and approvals.

## Recovery rule
Backup and restore is a recovery mechanism, not permission to delete. The existence of `runtime/backups` or any restore drill does not authorize deletion of runtime DBs, evidence, or source-of-truth records.

## Done when
- Protected paths and entities are explicit.
- Safe cleanup exceptions are narrow.
- Destructive operations require approval and preserve auditability.
