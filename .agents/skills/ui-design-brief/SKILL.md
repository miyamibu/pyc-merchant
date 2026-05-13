---
name: ui-design-brief
description: Use this skill before JPYC terminal UI/UX design or redesign work to clarify operator goals, payment/review/refund flows, information architecture, constraints, and validation before implementation. Do not use for backend-only ledger, monitor, or settlement contract tasks.
---

# UI Design Brief

## When to use
- Before changing terminal, mobile payment, review, refund, settlement, diagnostic, or ops-summary UI.
- When a user asks for a new UI, redesign, visual direction, or UX improvement.
- Before generating `gpt-image-2` UI concepts.

## When not to use
- Backend-only ledger, chain monitor, settlement export, security, or deployment tasks with no UI surface.
- Copy-only changes that do not affect layout, flow, state, or validation.

## Required inputs
- User goal and target surface.
- Existing route/file candidates.
- Relevant business states: invoice, payment, review, refund, settlement, diagnostic, or offline state.
- Constraints from `AGENTS.md` and `DESIGN.md`.

## Workflow
1. Read `AGENTS.md` and `DESIGN.md`.
2. Inspect existing `public/*.html`, `public/*.js`, and `public/app.css` patterns for the target surface.
3. Identify the user, primary task, success state, failure states, and risky operations.
4. Define source-of-truth priority and call out conflicts.
5. Produce a brief before implementation or image generation.
6. If image generation is useful, write a prompt that preserves existing tokens, states, and operational constraints.

## Output format
```md
Goal:

Context:

Target users:

Primary flow:

States to support:

Existing UI patterns to reuse:

Constraints:

Implementation notes:

Validation plan:

Failure handling:
```

## Validation checklist
- Existing components/tokens are named.
- Payment/review/refund/settlement states are not collapsed into vague success/failure labels.
- Non-custodial copy boundaries are preserved.
- Loading, empty, error, expired, offline, and review-required states are considered when relevant.
- Validation includes checks/screenshots appropriate to the UI change.

## Failure handling
- If the target flow or business state is unclear, ask before implementation.
- If the request conflicts with non-custodial or audit requirements, stop and explain.
- If generated images are requested, do not treat them as approval to implement.
