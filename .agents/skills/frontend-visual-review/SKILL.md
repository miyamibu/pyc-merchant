---
name: frontend-visual-review
description: Use this skill after JPYC terminal frontend UI changes to review visual quality, responsive behavior, accessibility, operational state clarity, existing design consistency, and validation evidence. Do not use for backend-only changes.
---

# Frontend Visual Review

## When to use
- After changes to `public/*.html`, `public/*.js`, or `public/app.css`.
- Before reporting completion for substantial UI/UX work.
- When asked to review screenshots or UI implementation quality.

## When not to use
- Backend-only, docs-only, or settlement-contract-only changes with no visible UI.

## Required inputs
- Files changed.
- Target screens and states.
- Validation commands available.
- Screenshots or local server URL when available.

## Workflow
1. Read `DESIGN.md`.
2. Inspect the changed UI against existing tokens and patterns.
3. Check desktop and mobile behavior where possible.
4. Check state coverage: loading, empty, error, expired, review-required, refund, settlement, offline/polling.
5. Check accessibility: focus, touch target, contrast, semantics, non-color status communication.
6. Run relevant checks or record why they were not run.
7. Save evidence under `artifacts/ui-review/YYYY-MM-DD/` for substantial UI work when possible.

## Output format
```md
Review summary:

Issues found:

Evidence:

Commands run:

Residual risk:
```

## Validation checklist
- Primary amount/status/action remains first-scan.
- No generated-image detail overrode a business rule.
- UI copy does not imply custody or automatic signing/refund execution.
- Responsive layout does not overlap or hide primary actions.
- Checks/screenshots are recorded or explicitly unavailable.

## Failure handling
- If visual verification cannot run, state the blocker and provide manual verification steps.
- If a severe UI or compliance issue is found, stop and recommend a fix before completion.
