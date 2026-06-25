
# Drift Report

Release ID: `goal-closure-20260625T000500Z`

## Status

`BLOCKED`

## Confirmed drift

- Worktree is dirty: `package.json`, `tests/helpers/server-process.mjs`, `tests/server-expiry-sweeper.test.mjs` are modified and `output/`, `scripts/story-api-retest.mjs`, `scripts/story-ui-retest.mjs`, `scripts/verify-story-tracker.mjs` are untracked.
- Runtime drift: current Node is `v25.8.1`; README baseline says `Node.js 24.17.0`.
- Release profile drift: the request covers both Commercial and Limited release closure, but a single signed profile was not selected.
- Commercial gate drift: current machine verdict is `NO_GO`, while Commercial release requires a GO-class verdict and Limited release also fails closed.
- External evidence drift: EXT/POC evidence is missing or pending; local validation cannot substitute real JPYC payment, real wallet device, public TLS, staff drill, or paid PoC KPI proof.
- Workbook drift cleared for this side run: `artifacts/story-tracker/jpyc-feature-story-status.xlsx` was updated to reference the 20260625 story/API/commercial/limited evidence IDs and `npm run story:tracker:verify` passed.
- Approval drift: legal, AML, privacy, APPI, JPYC token contract, confirmation policy, backscan policy, policy URL content, and release owner signoff are pending.

## No drift found

- Settlement export v1 contract files exist and were not changed.
- EXT/POC ID registry is discoverable from current evidence templates and validators; EXT-002 has a backward-compatible alias noted in `ID_REGISTRY.json`.
- Local validation commands completed; expected fail-closed gate exits are documented in `COMMAND_RUNS.json`.
