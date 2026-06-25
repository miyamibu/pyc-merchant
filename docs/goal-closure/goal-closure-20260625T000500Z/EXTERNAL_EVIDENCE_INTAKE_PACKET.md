# External Evidence Intake Packet

Release preparation ID: `goal-closure-20260625T000500Z`
Draft release ID: `01KVY31WWH28VKS1DN1QE3CZ7C`

## Goal

Give human owners the exact fields needed to turn remaining external gates from `missing` or `pending` into auditable input for the validator.

## Context

Current machine verdict is `NO_GO`. Local story retest, tracker verification, and static checks are prepared. The remaining release blockers require real external actions and signed approvals.

## Constraints

- Do not mark any item `status: pass` until the action actually happened.
- Do not invent approval refs, tx hashes, screenshots, TLS details, signatures, or KPI minutes.
- Do not modify original production evidence. Create a fresh timestamped evidence folder for the actual run.
- Do not put secrets in Markdown, logs, Git, or chat.

## Output Format For The Real Run

Create a new folder:

```text
docs/production/evidence/<YYYYMMDDTHHMMSSZ>/
```

Copy and fill the current templates:

```text
docs/production/evidence/templates/EXT-001-real-jpyc-payment.md
docs/production/evidence/templates/EXT-002-wallet-device-launch.md
docs/production/evidence/templates/EXT-003-public-fqdn-tls.md
docs/production/evidence/templates/EXT-004-store-ops-drill.md
docs/production/evidence/templates/POC-001-template.md
docs/production/evidence/templates/POC-002-template.md
docs/production/evidence/templates/POC-003-template.md
docs/production/evidence/templates/JPYC-CONTRACT-VERIFICATION.md
```

## Required Evidence

| ID | Required real input | Validator-critical fields |
|---|---|---|
| EXT-001 | Real JPYC payment on Polygon mainnet | `status: pass`, `actual_tx_hash`, `invoice_id`, `amount`, `expected_amount_atomic`, `block_number`, `block_timestamp`, `detected_at`, `status_transition`, `tester` |
| EXT-002 | Real HashPort Wallet device launch | `status: pass`, `hashport_wallet_ios_status: pass`, `hashport_wallet_android_status: pass`, `copy_fallback_status: pass`, `screenshot_ref`, `tester`, `checked_at` |
| EXT-003 | Public FQDN/TLS proof | `status: pass`, `domain`, `tls_issuer`, `tls_expiry`, `healthz_result`, `readyz_result`, `pay_ref_result`, `https_redirect_result` |
| EXT-004 | Signed store ops drill | `status: pass`, `participant`, `scenario`, `invoice_issue_time`, `qr_display_time`, `review_handling`, `refund_evidence_handling`, `daily_close`, `incident_escalation`, `self_resolution_result`, `operator_signature` |
| POC-001 | Paid PoC KPI pack | `status: pass`, `kpi_result`, `daily_close_reproduced`, `csv_reconciliation`, `signed_minutes_ref` |
| POC-002 | Paid PoC KPI pack | `status: pass`, `kpi_result`, `daily_close_reproduced`, `csv_reconciliation`, `signed_minutes_ref` |
| POC-003 | Paid PoC KPI pack | `status: pass`, `kpi_result`, `daily_close_reproduced`, `csv_reconciliation`, `signed_minutes_ref` |

## Validation Method

After the evidence folder is filled:

```bash
node scripts/production-validation/validate-commercial-evidence.mjs --evidence-dir docs/production/evidence/<YYYYMMDDTHHMMSSZ> --strict
npm run commercial:validate
```

For the final real-money release gate, pass an explicit release id, evidence dir, and signed manifest. Do not use latest evidence auto-selection.

## Failure Handling

- If any real field is unavailable, leave the status as `pending` and keep the machine verdict `NO_GO`.
- If public DNS/TLS is unavailable, do not fill EXT-003 as pass.
- If only simulator/mock/local evidence exists, do not use it for EXT-001 or EXT-002.
- If policy URLs are drafts or not publicly reachable over HTTPS, do not write them into `public/mobile.js`.
