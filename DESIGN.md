# DESIGN.md

## Goal
Keep the JPYC merchant terminal UI fast, trustworthy, and audit-aware for small shops, events, and proof-of-concept payment operations.

## Context
- Product: non-custodial JPYC Merchant Ops / Settlement Layer.
- Primary surfaces: terminal login, invoice creation, fixed terminal QR, mobile payment page, review/refund/settlement operations, diagnostics, and compact ops summaries.
- Existing frontend is static HTML/CSS/JS under `public/` served by the Node/Express app.
- Existing tokens live in `public/app.css` as CSS custom properties for color, radius, spacing, typography, shadows, control height, and tap target size.

## Source Of Truth
1. Current explicit user instruction.
2. Existing `public/*.html`, `public/*.js`, and `public/app.css` behavior and tokens.
3. This `DESIGN.md`.
4. Approved Figma/design files.
5. Screenshots or `gpt-image-2` generated images.
6. Ambiguous natural-language preferences.

If sources conflict, explain the conflict before changing the UI direction.

## UX Principles
- The UI must make payment state, review state, refund state, and settlement traceability clear before it looks decorative.
- Treat terminal operators as busy, non-technical users: actions should be obvious, labels should be concrete, and risky operations should surface reason and next step.
- Preserve the non-custodial boundary in copy and flows. Never imply the app holds funds, keys, or signing authority.
- Keep auditability visible where it helps operations: invoice reference, payment/refund evidence, review reasons, settlement links, and diagnostic status.
- Prefer calm, high-contrast operational screens over promotional or decorative layouts.

## Visual Direction
- Use the current light operational palette in `public/app.css`: blue for primary actions/info, green for success, amber for warning, red for danger, neutral surfaces for forms and cards.
- Preserve `--tap-target-min: 44px` and existing control sizing for terminal and mobile reliability.
- Keep cards and panels compact. Use them for real operational grouping, not decoration.
- Avoid dense gradients, decorative blobs, or visual effects that reduce legibility on store devices.
- Amounts, status, QR, and next action must remain first-scan information.

## Layout
- Terminal screens should prioritize current invoice, QR/payment status, amount, and operational actions.
- Mobile payment pages should minimize steps and keep QR/wallet instructions readable on narrow screens.
- Use stable dimensions for QR, status panels, action rows, and diagnostic sections to avoid layout shift during SSE/polling updates.
- Responsive behavior should preserve action order and prevent primary controls from moving unpredictably.

## Components
- Reuse existing CSS classes, tokens, and DOM patterns before creating new ones.
- Keep form errors inline and specific.
- Loading, empty, expired, review-required, refund-pending, offline/polling, and diagnostic states must be explicitly represented when touched.
- Use existing QR and wallet payload patterns; do not invent new payment semantics in UI copy.

## Accessibility
- Preserve visible focus states from `public/app.css`.
- Maintain 44px minimum touch targets for terminal/mobile actions.
- Use semantic buttons/links and ARIA only when native semantics are insufficient.
- Do not communicate status by color alone; include text.
- Ensure amount, status, and review/refund warnings remain readable under mobile viewport widths.

## Validation
For UI changes, run the most relevant checks available:
- Syntax/static checks: `npm run check`.
- Tests: `npm test` or focused `node --test ...`.
- Smoke flow when relevant: `npm run test:smoke`.
- Browser/manual review of terminal and mobile payment pages.
- For substantial UI work, save desktop/mobile screenshots and command outputs under `artifacts/ui-review/YYYY-MM-DD/` when possible.

## Avoid
- New frontend dependencies without approval.
- UI copy that implies custody, automatic refund execution, or wallet control.
- Hiding review/refund/settlement uncertainty behind generic success states.
- Hard-coding new colors or spacing outside the existing token system unless approved.
- Treating generated images as implementation specs.
