# Commercial Closeout Action Packets

## Status (2026-04-28)

- Machine verdict: `NO_GO` (score 1 / 10)
- Tests: 166 / 166 pass (all suites)
- Static / security checks: pass
- Remaining blockers: **external human actions only** (no repo-internal code changes needed)

This document gives each human owner the exact instruction, evidence template, validation command, and write-back rule for every remaining blocker. Items stay `pending` until real evidence is supplied. Nothing here may be treated as approval, legal advice, or a pass determination.

---

## Packet L — Legal / Approval Closeout

### Goal
Resolve Q-001..Q-010, RQ-01..RQ-10, and A-1..A-4 runtime gates with signed legal/accounting/privacy/APPI evidence recorded in `docs/88-approval-minutes-and-signoff.md` and `docs/97-commercial-release-record-template.md`.

### Blocker: Q-001..Q-010 — external approval items

Source: `docs/open-questions.md`

| ID | Question | Owner | Blocking gate |
|---|---|---|---|
| Q-001 | 運用形態 (Model A / B / C) | 法務責任者 | A-1 Legal |
| Q-002 | 登録・届出の要否 | 法務責任者 | A-1 Legal |
| Q-003 | 対応チェーンの確定 | 技術責任者 + 運用責任者 | A-5 JPYC contract |
| Q-004 | JPYCコントラクトの確定値 | 技術責任者 | A-5 JPYC contract |
| Q-005 | 期限300秒と完了判定ポリシー | 技術責任者 + CS責任者 | A-6 confirmations |
| Q-006 | 返金ポリシー（責任・期限・手数料） | 運用責任者 + 会計責任者 | A-7 refund |
| Q-007 | 返金ウォレット保管方式 | セキュリティ責任者 | A-7 refund |
| Q-008 | ウォレット対応範囲 | プロダクト責任者 | A-8 release verdict |
| Q-009 | 会計処理（税・評価・仕訳） | 会計責任者 | G-002 |
| Q-010 | 本番Go判定条件 | 四責任者 | A-8 release verdict |

**Done when**: Each Q has `答え / 根拠法令・文書 / 責任者 / 回答日 / 残課題` recorded in `docs/open-questions.md` and echoed in the approval minutes.

**Failure behavior**: If Q-001, Q-002, or Q-007 remains unanswered, commercial use remains blocked.

### Blocker: RQ-01..RQ-10 — legal/expert questionnaire

Source: `docs/11-regulatory-questions.md`

Each item requires: `回答日 / 回答者 / 参考法令または文書URL / 結論 / 残課題`.

Key blocking items:

- **RQ-01** (Model A/B/C): unlocks A-1
- **RQ-02** (登録対象か): unlocks A-1
- **RQ-07** (返金法的責任主体): unlocks A-7; if unanswered keeps Phase 2+ BLOCKED

**Done when**: RQ-01..RQ-10 in `docs/11-regulatory-questions.md` are filled with external-expert responses.

### Blocker: A-1..A-4 — runtime gates (fail-closed)

Source: `docs/92-legal-aml-appi-runtime-gates.md`, `docs/80-approval-plan.md`

Each gate must have: `approval_ref` (format: `LEGAL-YYYY-MMDD-NNN`) in `.env.production` AND in signed minutes.

| Gate | Env vars to set | Approval ref format | Validation command |
|---|---|---|---|
| A-1 Legal | `LEGAL_GATE_APPROVED=true` + `LEGAL_GATE_APPROVAL_REF=LEGAL-YYYY-MMDD-NNN` | `LEGAL-YYYY-MMDD-NNN` | `npm run commercial:validate` / `GET /readyz` |
| A-2 AML | `AML_POLICY_APPROVED=true` + `AML_POLICY_APPROVAL_REF=AML-YYYY-MMDD-NNN` | `AML-YYYY-MMDD-NNN` | same |
| A-3 Privacy | `PRIVACY_POLICY_APPROVED=true` + `PRIVACY_POLICY_APPROVAL_REF=PRIV-YYYY-MMDD-NNN` | `PRIV-YYYY-MMDD-NNN` | same |
| A-4 APPI | `APPI_POLICY_APPROVED=true` + `APPI_POLICY_APPROVAL_REF=APPI-YYYY-MMDD-NNN` + `APPI_RETENTION_POLICY_REF` + `APPI_DELETION_PROCEDURE_REF` + `APPI_DISCLOSURE_PROCEDURE_REF` | `APPI-YYYY-MMDD-NNN` | same |

**Write-back rule** (human owner):
1. Obtain signed approval document from legal expert.
2. Assign approval ref (format above).
3. Set env vars in `.env.production` (outside git — never commit actual values).
4. Run `npm run commercial:validate` and capture output.
5. Record approval ref and evidence path in `docs/88-approval-minutes-and-signoff.md` Gate signoff table.
6. Record in `docs/97-commercial-release-record-template.md` Signoff matrix.

**Policy drafts requiring legal review before A-1/A-3/A-4 can close**:
- `docs/legal/terms-draft.md` → reviewed + URL published → write URL into `POLICY_URLS.terms` in `public/mobile.js`
- `docs/legal/privacy-policy-draft.md` → reviewed + URL published → write URL into `POLICY_URLS.privacy`
- `docs/legal/refund-policy-draft.md` → reviewed + URL published → write URL into `POLICY_URLS.refund`
- `docs/legal/jpyc-legal-classification-decision-pack.md` → decision on Model A/B/C → fills Q-001, RQ-01

**Legal classification tool**: `docs/legal/jpyc-legal-classification-decision-pack.md` contains the 10-question questionnaire (LQ-01..LQ-10) and Model A/B/C comparison table. Fill this with legal expert and record the answer in Q-001 / RQ-01.

**Failure behavior**: Without A-1..A-4 in production env, server startup is fail-closed. `GET /readyz` will reflect `approved: false` for missing gates.

---

## Packet EXT — Real-World Validation Closeout

### Goal
Close EXT-001..EXT-004 only with real external evidence. Templates are seeded at `docs/production/evidence/20260427T163114Z/`.

Source: `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`, `docs/prompts/ext-closeout-prompts.md`

### EXT-001 — 実JPYC少額決済

**Status**: pending
**Template**: `docs/production/evidence/20260427T163114Z/EXT-001-real-jpyc-payment.md`
**Owner**: Finance + Tech lead

**Pre-conditions**:
- Production env deployed with real `APP_SECRET`, `SERVICE_INGEST_SECRET`, approved contract gate (A-5 / A-6)
- Chain monitor running against Polygon mainnet
- Real JPYC balance in a non-custodial wallet

**Execution command**:
```bash
REAL_PAYMENT_MODE=1 node scripts/production-validation/validate-smoke-payment-flow.mjs
```

**What must be recorded** (no fabrication):
- Invoice ID
- Real tx hash from Polygon mainnet
- Observed invoice status transition (`confirming → paid` or expected review path)
- Confirmation block number and confirmations count
- Screenshot or `GET /api/v1/invoices/{id}` JSON response

**Close condition**: Invoice transitions to `paid` (or `review_required` if test path) with tx hash verifiable on-chain. Record in template and run `npm run commercial:validate`.

### EXT-002 — HashPort Wallet 実機起動

**Status**: pending
**Templates**: `docs/production/evidence/20260427T163114Z/EXT-002-wallet-device-launch.md` (canonical), `EXT-002-hashport-device-launch.md` (alias)
**Owner**: Store ops / Tech lead
**Reference**: `docs/commercial/wallet-device-evidence-matrix.md`

**Prepare evidence device set**:
```bash
npm run evidence:device:prepare
```

**What must pass**:
- iOS: HashPort Wallet opens payment URI, displays amount, confirms send
- Android: same
- Copy fallback: address copy to clipboard works when deep link unavailable

**Close condition**: All three paths tested on real devices. Record device model, OS version, HashPort Wallet version, and result (pass/fail) per path in the template.

### EXT-003 — 公開TLSホスト確認

**Status**: pending
**Template**: `docs/production/evidence/20260427T163114Z/EXT-003-public-fqdn-tls.md`
**Owner**: Infra

**Execution command** (run after real FQDN + TLS + nginx is configured):
```bash
bash scripts/deploy/healthcheck.sh https://pay.miyamibu.xyz/healthz
```

**What must be verified**:
- `https://pay.miyamibu.xyz/healthz` → 200
- `https://pay.miyamibu.xyz/readyz` → 200 with approval gates reflecting actual env
- `https://pay.miyamibu.xyz/pay?ref=<signed-ref>` → redirects or serves payment page
- TLS certificate valid, no self-signed, chain complete

**Close condition**: All three endpoints verified with HTTPS. Record public host, TLS issuer, certificate expiry, and check results in template.

### EXT-004 — 限定店舗オペレーション訓練

**Status**: pending
**Template**: `docs/production/evidence/20260427T163114Z/EXT-004-store-ops-drill.md`
**Owner**: Store ops
**Reference**: `docs/91-limited-store-release-checklist.md`, `docs/93-incident-drill.md`, `docs/storefront/posting-evidence-template.md`

**Steps** (all require real store staff):
1. 開店前チェック (terminal login, QR display, connection check)
2. 通常決済フロー (staff-led payment with test JPYC)
3. 日次締め / CSV出力 (closing → settlement export)
4. review / 返金証跡 (at least one review case resolved)
5. Incident escalation drill (`docs/93-incident-drill.md`)
6. 閉店チェック (terminal logout, evidence photo)

**Storefront posting pre-condition**: Posting evidence must be recorded using `docs/storefront/posting-evidence-template.md` before drill is considered complete. Include photo evidence file reference.

**Close condition**: Operator signature on template, all 6 steps recorded, photo evidence referenced.

### EXT validation commands (after all evidence is recorded):
```bash
npm run commercial:validate
```
Verdict remains `NO_GO` until all Required EXT items are `status: pass` in their templates.

---

## Packet OPS — Operations Setup Closeout

### Goal
Prepare production operations without exposing secrets or weakening runtime gates.

### OPS-1 — Production Secrets Registration

**Owner**: Security / Infra operator
**Never commit actual secret values to git.**

Secrets that must be registered in Secret Manager before production:

| Secret name | Purpose | Minimum entropy | Current validation state |
|---|---|---|---|
| `APP_SECRET` | Session signing (JWT) | 32 bytes / 64 hex chars | `NO_GO`: weak/default in local env |
| `SERVICE_INGEST_SECRET` | HMAC-SHA256 for chain-monitor → server | 32 bytes / 64 hex chars | `NO_GO`: weak/default in local env |
| `METRICS_SECRET` | `/metrics` endpoint auth | 16 bytes / 32 hex chars | `NO_GO`: weak/default in local env |

**Generation (human operator, not committed)**:
```bash
# Run this locally, copy to Secret Manager — never paste into any tracked file
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Write-back rule**:
1. Generate each secret locally.
2. Register in Secret Manager (platform: refer to `docs/61-secret-management.md`).
3. In `docs/97-commercial-release-record-template.md`, record only the Secret Manager reference ID (not the value itself).
4. Set env var references (not values) in `.env.production`.
5. Run `npm run production:validate:env` in the target environment.

**Rotation runbook**: `docs/security/service-ingest-secret-rotation-runbook.md`
**Compromise playbook**: `docs/security/service-ingest-secret-compromise-playbook.md`
**Drill evidence template**: `docs/security/secret-rotation-drill-evidence-template.md`

### OPS-2 — Production Config Flags

Current `NO_GO` blockers from commercial validate output that require manual env var changes (no code change needed):

| Env var | Required value | Why blocked |
|---|---|---|
| `WALLET_ADAPTER_TYPE` | `reown` (or approved adapter) | `mock` is blocked in commercial mode |
| `CORS_ALLOW_ORIGINS` | `https://pay.miyamibu.xyz` | must not be empty |
| `SETTLEMENT_UNRESOLVED_REVIEW_POLICY` | `block` | must be `block` in commercial mode |
| `COMMERCIAL_GO_MODE` | `true` | enables commercial validation |
| `APP_ENV` | `production` | required for fail-closed startup checks |

Also required (A-5 / A-6 gates):
| Env var | Required value |
|---|---|
| `CHAIN_ID` | `137` |
| `TOKEN_CONTRACT` | approved JPYC Polygon contract address |
| `APPROVED_JPYC_TOKEN_CONTRACT` | same as `TOKEN_CONTRACT` |
| `JPYC_CONTRACT_APPROVAL_REF` | approval ref from A-5 gate |
| `TOKEN_DECIMALS` | `18`（on-chain atomic unit） |
| `JPYC_BASE_UNIT_SCALE` | `1000000` |
| `APPROVED_TOKEN_NAME` | independently approved value when available; otherwise blank |
| `APPROVED_TOKEN_CODE_HASH` | independently approved Keccak-256 hash when available; otherwise blank |
| `APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH` | independently approved value when proxy verification applies; otherwise blank |
| `REQUIRED_CONFIRMATIONS` | approved value (recommend ≥ 12) |
| `MIN_REQUIRED_CONFIRMATIONS` | same |
| `CONFIRMATIONS_POLICY_APPROVAL_REF` | approval ref from A-6 gate |
| `MONITOR_BACKSCAN_BLOCKS` | approved value |
| `MIN_MONITOR_BACKSCAN_BLOCKS` | same |
| `BACKSCAN_POLICY_APPROVAL_REF` | approval ref from A-6 gate |

**Validation after setting**:
```bash
npm run production:validate:env
npm run commercial:validate
GET /readyz
```

### OPS-3 — Policy URL Write-Back

**Pre-condition**: Legal-reviewed terms/privacy/refund policy documents must be published at public HTTPS URLs before this step. Do not write draft or local paths.

**Write-back location**: `public/mobile.js` — `POLICY_URLS` constant (lines ~5-10):
```js
const POLICY_URLS = {
  terms: "https://<your-domain>/terms",
  privacy: "https://<your-domain>/privacy",
  refund: "https://<your-domain>/refund",
};
```

**Write-back rule**:
1. Confirm each URL returns 200 with HTTPS.
2. Confirm the policy text has been approved by legal (A-1 / A-3 approval refs must already exist).
3. Update `POLICY_URLS` in `public/mobile.js` with the real URLs.
4. Run `npm run check` and `npm test` to confirm no regressions.
5. Record the URLs and approval refs in `docs/97-commercial-release-record-template.md`.

**Also update** `POLICY_VERSIONS` constant if version identifiers change from `draft-v1`.

### OPS-4 — Storefront Posting Evidence

**Template**: `docs/storefront/posting-evidence-template.md`
**Pre-condition**: Legal-approved text for `docs/storefront/payment-notice-poster.md` must be confirmed.

**Required before EXT-004 store drill**:
1. Print approved poster (A3 main + A6 compact).
2. Post at all required locations (register, QR display area, entrance).
3. Photograph each posting with timestamp visible.
4. Fill `docs/storefront/posting-evidence-template.md` with: posting date, location, approver name, photo file references.

### OPS-5 — Four-Owner Go / No-Go Signoff

**Template**: `docs/88-approval-minutes-and-signoff.md`
**Reference**: `docs/91-go-no-go-checklist.md` (G-001..G-012), `docs/87-go-no-go-evidence-matrix.md`

**Required attendees for human verdict**:
- 法務責任者 (A-1, A-2, A-3, A-4, G-001)
- 会計責任者 (A-2, G-002, G-009)
- 運用責任者 (A-7, G-003, G-008, G-010)
- 技術責任者 (A-5, A-6, G-004, G-005, G-006, G-007, G-011)
- セキュリティ責任者 (A-7, G-012) [recommended]

**Meeting pre-conditions** (all must be true before scheduling):
- A-1..A-4 approval refs obtained
- EXT-001..EXT-004 evidence recorded as `status: pass`
- `npm run commercial:validate` run and scorecard available
- `docs/97-commercial-release-record-template.md` pre-filled to draft state

**Conditional-Go**: Only available if `docs/89-conditional-go-guardrails.md` preconditions are all met (A-1..A-4 approved, A-5/A-6 refs present, only release evidence remaining). Requires explicit written authorization in signed minutes with 30-day limit, store/terminal scope, and auto-stop conditions.

---

## Current Blocker Summary

| Blocker | Type | Owner | Unblocked by |
|---|---|---|---|
| Legal gate (A-1) missing | Packet L | 法務責任者 | Q-001, Q-002, RQ-01, RQ-02 answered + approval ref |
| AML gate (A-2) missing | Packet L | 法務責任者 + 会計責任者 | RQ-05, RQ-06 answered + approval ref |
| Privacy gate (A-3) missing | Packet L | 法務責任者 | PRIVACY_POLICY_APPROVAL_REF issued |
| APPI gate (A-4) missing | Packet L | 法務責任者 | All 4 APPI refs issued |
| JPYC contract gate (A-5) | Packet OPS | 技術責任者 | Q-003, Q-004 answered + contract ref set |
| Confirmation policy (A-6) | Packet OPS | 技術責任者 | Q-005 answered + policy ref set |
| Backscan policy (A-6) | Packet OPS | 技術責任者 | Same as above |
| `WALLET_ADAPTER_TYPE=mock` | Packet OPS | 技術責任者 | Set to `reown` + `REOWN_PROJECT_ID` configured |
| `APP_SECRET` weak | Packet OPS | Security | OPS-1 secret generation + Secret Manager |
| `SERVICE_INGEST_SECRET` weak | Packet OPS | Security | OPS-1 secret generation + Secret Manager |
| `METRICS_SECRET` weak | Packet OPS | Security | OPS-1 secret generation + Secret Manager |
| `CORS_ALLOW_ORIGINS` empty | Packet OPS | Infra | Set to public FQDN |
| `settlement_unresolved_review_policy` | Packet OPS | 運用責任者 | Set `SETTLEMENT_UNRESOLVED_REVIEW_POLICY=block` |
| EXT-001 pending | Packet EXT | Finance + Tech lead | Real JPYC payment with tx hash |
| EXT-002 pending | Packet EXT | Store ops | HashPort real device test |
| EXT-003 pending | Packet EXT | Infra | Public FQDN + TLS verified |
| EXT-004 pending | Packet EXT | Store ops | Store drill + signed evidence |
| Policy URLs not published | Packet OPS | 法務責任者 | Policies legally reviewed + HTTPS published |
| Four-owner signoff | Packet OPS | 四責任者 | All above closed |

---

## Validation Commands Reference

```bash
# After any env change
npm run check
npm test
npm run commercial:validate

# After production env is configured (target env only)
npm run production:validate:env

# After external evidence templates are filled
npm run evidence:external:prepare   # creates new pending templates if needed
npm run commercial:validate         # re-evaluates EXT status

# After real JPYC payment
REAL_PAYMENT_MODE=1 node scripts/production-validation/validate-smoke-payment-flow.mjs

# After public TLS is live
bash scripts/deploy/healthcheck.sh https://pay.miyamibu.xyz/healthz

# After approval env vars are set
# Visit: GET https://pay.miyamibu.xyz/readyz
```

## Safety Constraints Observed

- No approval refs, tx hashes, screenshots, policy URLs, domain names, TLS status, or secret values were invented.
- All EXT items remain `pending` — templates exist but are not filled.
- `docs/97-commercial-release-record-template.md` was not filled; signoff matrix remains in `pending` state.
- `POLICY_URLS` in `public/mobile.js` was not updated (no legally reviewed public URLs available).
- No `.env`, `.env.production`, runtime DB, `runtime/`, or production evidence was modified.
