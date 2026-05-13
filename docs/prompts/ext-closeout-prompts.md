# EXT Closeout Prompts (EXT-001..EXT-004)

## Goal
`docs/production/BLOCKED_EXTERNAL_VALIDATION.md` の `EXT-001..004` を、実証跡ベースで正しく closeout するための実行 prompt を提供する。

## Context
- repo validation pack の `PASS` は external required evidence の代替ではない。
- `GO` / `COMMERCIAL_GO` 判定では `Required` の EXT-001..004 がすべて `pass` で閉じている必要がある。
- 実送金、実機確認、公開 TLS 確認、店舗訓練は人間主導の external activity。

## Constraints
- 実施していない external 項目を `pass` として記録しない。
- tx hash、実機結果、TLS到達確認、訓練署名は推測で埋めない。
- non-custodial 境界（秘密鍵非保持・署名非代行）を崩す提案をしない。
- evidence path は canonical naming（EXT-001..004）を維持する。

## Done when
- 実行者が EXT-001..004 ごとの prompt をそのまま使って closeout を進められる。
- 各 prompt に `Goal`、`Context`、`Constraints`、`Done when`、`Output format`、`Validation method`、`Failure-handling behavior` が含まれる。
- 未実施時は `pending` を維持し、blocker を明示する運用が担保される。

## EXT-001 prompt template (Real JPYC payment)
```md
You are Worker JPYC External Closeout.
Work ONLY in /Users/mimac/Desktop/JPYC決済端末_MVP_UIUX. Do not edit any other repo.

Goal:
Close EXT-001 using real JPYC payment evidence.

Context:
- Canonical source: docs/production/BLOCKED_EXTERNAL_VALIDATION.md
- Item: EXT-001 実JPYC少額決済
- Canonical execution: REAL_PAYMENT_MODE=1 node scripts/production-validation/validate-smoke-payment-flow.mjs
- Canonical evidence path: docs/production/evidence/<timestamp>/EXT-001-real-jpyc-payment.md

Constraints:
- Do not fabricate tx hash, payer wallet, block number, or status transitions.
- Keep non-custodial boundary: do not add key custody or signing logic.
- If the real transfer was not completed, keep status as pending and record exact blocker.
- Keep diffs minimal; do not modify unrelated docs or code.

Done when:
- Evidence file records real execution timestamp, tx hash, observed transition (`confirming -> paid` or expected review path), and operator signoff.
- EXT-001 can be objectively marked pass; otherwise remains pending with blocker.

Output format:
- Files changed (absolute paths)
- Commands run + results
- Validation checks
- Blockers (if any)

Validation method:
- Confirm evidence file exists at canonical path.
- Confirm tx hash and state transition text are present.
- Re-check EXT-001 close condition in BLOCKED_EXTERNAL_VALIDATION.

Failure-handling behavior:
- If command fails or confirmation is missing, do not force pass.
- Keep pending, capture the exact error/output, and request human retry timing.
```

## EXT-002 prompt template (HashPort Wallet device launch)
```md
You are Worker JPYC External Closeout.
Work ONLY in /Users/mimac/Desktop/JPYC決済端末_MVP_UIUX. Do not edit any other repo.

Goal:
Close EXT-002 with real iOS/Android HashPort Wallet launch evidence.

Context:
- Canonical source: docs/production/BLOCKED_EXTERNAL_VALIDATION.md
- Item: EXT-002 HashPort Wallet 実機起動
- Canonical preparation: npm run evidence:device:prepare
- Canonical evidence path: docs/production/evidence/<timestamp>/EXT-002-wallet-device-launch.md
- Close condition: iOS / Android / copy fallback がすべて pass

Constraints:
- Do not mark pass without real device checks.
- Do not invent screenshots, app build versions, or copy-fallback outcomes.
- Keep non-custodial boundary and avoid unrelated code changes.
- Preserve canonical file naming (`EXT-002-wallet-device-launch.md`).

Done when:
- Evidence file contains iOS result, Android result, copy fallback result, and human signoff.
- EXT-002 is pass only when all required checks are pass.

Output format:
- Files changed (absolute paths)
- Commands run + results
- Validation checks
- Blockers (if any)

Validation method:
- Verify canonical EXT-002 evidence file exists.
- Verify all three required result fields (iOS/Android/copy fallback) are explicitly recorded.
- Re-check EXT-002 close condition in BLOCKED_EXTERNAL_VALIDATION.

Failure-handling behavior:
- If any device or copy fallback check is incomplete, keep pending.
- Record missing device/resource details and next executable step.
```

## EXT-003 prompt template (Public FQDN + TLS)
```md
You are Worker JPYC External Closeout.
Work ONLY in /Users/mimac/Desktop/JPYC決済端末_MVP_UIUX. Do not edit any other repo.

Goal:
Close EXT-003 with public HTTPS host and runtime endpoint evidence.

Context:
- Canonical source: docs/production/BLOCKED_EXTERNAL_VALIDATION.md
- Item: EXT-003 公開TLSホスト確認
- Canonical execution: bash scripts/deploy/healthcheck.sh https://pay.miyamibu.xyz/healthz
- Canonical evidence path: docs/production/evidence/<timestamp>/EXT-003-public-fqdn-tls.md
- Close condition: HTTPS で `healthz` / `readyz` / `/pay?ref=` が確認できる

Constraints:
- Do not claim public reachability without real HTTPS checks.
- Do not replace required public-host evidence with localhost checks.
- Do not alter deploy/security policy files unless explicitly required.
- Keep status pending when DNS/TLS/runtime prerequisites are missing.

Done when:
- Evidence file includes public host, TLS verification notes, and endpoint results for `healthz`, `readyz`, `/pay?ref=`.
- EXT-003 can be marked pass with reproducible external evidence.

Output format:
- Files changed (absolute paths)
- Commands run + results
- Validation checks
- Blockers (if any)

Validation method:
- Confirm EXT-003 canonical evidence file exists.
- Confirm all required endpoint results are recorded with HTTPS host context.
- Re-check EXT-003 close condition in BLOCKED_EXTERNAL_VALIDATION.

Failure-handling behavior:
- If TLS/host is unavailable, keep pending.
- Capture exact failing endpoint and error text; provide concrete next action for human owner.
```

## EXT-004 prompt template (Limited-store operations drill)
```md
You are Worker JPYC External Closeout.
Work ONLY in /Users/mimac/Desktop/JPYC決済端末_MVP_UIUX. Do not edit any other repo.

Goal:
Close EXT-004 with signed limited-store operations drill evidence.

Context:
- Canonical source: docs/production/BLOCKED_EXTERNAL_VALIDATION.md
- Item: EXT-004 限定店舗オペレーション訓練
- Canonical guides: docs/91-limited-store-release-checklist.md and docs/93-incident-drill.md
- Canonical evidence path: docs/production/evidence/<timestamp>/EXT-004-store-ops-drill.md
- Close condition: 締め処理、review対応、返金証跡、incident escalation が署名付きで記録

Constraints:
- Do not mark pass without real store drill execution and human signatures.
- Do not infer drill outcomes from repo-only tests.
- Keep non-custodial and audit-traceability boundaries unchanged.
- Keep diffs minimal and limited to closeout evidence/docs.

Done when:
- Evidence file records drill scenario, participants, outcomes, incident escalation path, and signoff.
- EXT-004 is pass only when all required operational evidence is present.

Output format:
- Files changed (absolute paths)
- Commands run + results
- Validation checks
- Blockers (if any)

Validation method:
- Verify EXT-004 evidence file exists at canonical path.
- Verify required evidence sections (closing, review, refund evidence, escalation, signature) are present.
- Re-check EXT-004 close condition in BLOCKED_EXTERNAL_VALIDATION.

Failure-handling behavior:
- If staffing or drill execution is incomplete, keep pending.
- Record what was completed vs missing, then propose the next concrete drill slot.
```
