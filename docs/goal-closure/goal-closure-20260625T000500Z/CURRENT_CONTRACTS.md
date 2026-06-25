
# Current Contracts

Release ID: `goal-closure-20260625T000500Z`

## Settlement Export Contract v1

Source files:

- `docs/contracts/settlement-export-v1.md`
- `docs/contracts/settlement-export-v1.schema.json`
- `tests/accounting/settlement-export-contract.test.mjs`

This run did not modify the settlement export contract.

## Commercial GO Contract

Source files:

- `scripts/production-validation/validate-commercial-go.mjs`
- `scripts/production-validation/commercial-gate.mjs`
- `scripts/production-validation/limited-gate.mjs`
- `docs/90-production-validation-plan.md`

Current machine verdict: `NO_GO`

## External Evidence Contract

Canonical IDs:

- `EXT-001`: real JPYC payment
- `EXT-002`: wallet device launch
- `EXT-003`: public FQDN/TLS
- `EXT-004`: store ops drill
- `POC-001`, `POC-002`, `POC-003`: paid PoC KPI evidence

Templates are under `docs/production/evidence/templates/`. Current evidence is not sufficient for GO.

## Story Tracker Contract

Canonical workbook:

- `artifacts/story-tracker/jpyc-feature-story-status.xlsx`

Validator:

- `npm run story:tracker:verify`

Result: validator passed, but this run did not patch the workbook with the new side-run evidence.
