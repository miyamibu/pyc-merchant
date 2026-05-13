---
name: image-to-ui-implementation
description: Use this skill when converting a generated UI image, screenshot, or Figma-derived visual direction into JPYC terminal frontend implementation. It must produce an implementation brief and receive user approval for generated images before editing code. Do not use for backend-only tasks.
---

# Image To UI Implementation

## When to use
- A `gpt-image-2` UI image, screenshot, or Figma-derived visual reference is provided for terminal/mobile UI work.
- A visual direction needs to become changes in `public/*.html`, `public/*.js`, or `public/app.css`.

## When not to use
- Backend-only work.
- Visual references that have not been approved by the user.
- Tasks that only adjust copy without changing UI structure or behavior.

## Required inputs
- Approved image/screenshot/Figma reference, or explicit instruction to generate options.
- Target screen and target viewport/device.
- Existing files and tokens to reuse.
- Validation expectations.

## Generated image approval
If UI images are generated or received as options:
1. Present the image options to the user.
2. Summarize each option's layout, tone, strengths, and implementation risks.
3. Ask the user to choose one option or request changes.
4. Do not implement until the user explicitly approves a direction.
5. After approval, produce the implementation brief before editing code.

## Workflow
1. Read `AGENTS.md` and `DESIGN.md`.
2. Inspect current UI files and CSS tokens.
3. Convert the approved visual reference into an implementation brief.
4. Map each visual element to existing DOM/CSS/JS patterns where possible.
5. Identify states: loading, empty, error, expired, review-required, refund, settlement, offline/SSE/polling.
6. Edit only the needed frontend files.
7. Validate with available checks and screenshots when possible.

## Implementation brief must include
- Layout structure.
- Component list.
- Color tokens.
- Typography.
- Spacing scale.
- Responsive behavior.
- Loading, empty, error, expired, review/refund states.
- Accessibility requirements.
- Implementation risks.
- Validation plan.

## Output format
```md
Implementation brief:

Files to change:

Validation plan:

Post-change evidence:
```

## Validation checklist
- Existing tokens are reused unless approved otherwise.
- Generated image details that conflict with existing UI are adapted, not blindly copied.
- Non-custodial and audit language remains accurate.
- Desktop/mobile screenshots are saved for substantial UI work when possible.
- `npm run check` and focused tests are run when relevant.

## Failure handling
- If a visual reference conflicts with existing behavior or compliance/audit rules, stop and explain.
- If a new dependency appears useful, explain tradeoffs and wait for approval.
- If screenshots cannot be captured, state why and provide the next best validation.
