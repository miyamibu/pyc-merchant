# Dependency Security Remediation 20260619T061150Z

## Goal
Remove high/critical npm audit findings without `npm audit fix --force` or major dependency migration.

## Context
Release closeout Phase B captured the current audit state under:

- `artifacts/closeout/20260619T061150Z/logs/npm-audit-before.json`
- `artifacts/closeout/20260619T061150Z/logs/npm-explain-ws-before.txt`
- `artifacts/closeout/20260619T061150Z/logs/npm-explain-qs-before.txt`
- `artifacts/closeout/20260619T061150Z/logs/npm-outdated-before.json`

## Advisories Before

- `ws` via direct dependency `ethers@6.16.0`
  - `GHSA-58qx-3vcg-4xpx`, moderate, range `>=8.0.0 <8.20.1`
  - `GHSA-96hv-2xvq-fx4p`, high, range `>=8.0.0 <8.21.0`
  - installed path: `ethers -> ws@8.17.1`
- `qs` via direct dependency `express@4.22.1` and transitive `body-parser@1.20.4`
  - `GHSA-q8mj-m7cp-5q26`, moderate, range `>=6.11.1 <=6.15.1`
  - installed path: `express/body-parser -> qs@6.14.2`

## Remediation

- Updated `ethers` within v6 from `^6.15.0` to `^6.17.0`.
  - `ethers@6.17.0` depends on `ws@8.21.0`, outside the high advisory range.
- Updated `express` within v4 from `^4.21.2` to `^4.22.2`.
  - This keeps the existing Express 4 API surface.
  - `express@4.22.2` and `body-parser@1.20.5` allow patched `qs@6.15.2`.
- No `overrides` were needed.
- No `npm audit fix --force` was used.
- No major dependency upgrade was introduced.

## Advisories After

`npm audit --json` and `npm audit --audit-level=high` reported zero vulnerabilities after lockfile regeneration.

Evidence:

- `artifacts/closeout/20260619T061150Z/logs/npm-audit-after.json`
- `artifacts/closeout/20260619T061150Z/logs/npm-audit-high-after.log`

## Validation

Ran with Node `v20.20.2`:

- `npm ci`
- `npm audit --json`
- `npm audit --audit-level=high`
- `npm run check`
- `npm test`
- `npm run test:smoke`
- `npm run test:audit-chain`

All validation commands completed successfully.

## Failure-handling behavior

If a future audit reintroduces high/critical findings, Phase B must not be considered complete until the advisory path is updated or an explicit scoped risk acceptance is approved.
