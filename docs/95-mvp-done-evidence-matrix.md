# 95. MVP Done Evidence Matrix

## Goal
MVP Done 条件を「雰囲気」ではなく、判定・証跡・owner 付きで固定する。

## Context
- 自動テストで閉じる項目と、実機 / 実送金 / 公開 FQDN / sign-off が必要な項目を分離する。
- `external pending` は未実施のまま正直に残し、 `done` 扱いしない。
- 証跡保存先は [docs/production/evidence](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/evidence) を正本とする。

## Constraints
- 実機で確認していない項目を確認済みと書かない。
- 実JPYC / HashPort / FQDN/TLS / Go-No-Go sign-off は external pending のまま管理できるようにする。
- 実装・docs・tests・validation pack の参照先を一致させる。

## Matrix
| Item | 判定 | 主証跡 | Owner |
|---|---|---|---|
| receive_address 粒度 (`1 invoice = 1 receive_address`) | pass / fail | `tests/address-pool-sse.test.mjs`, `tests/security-hardening.test.mjs`, [40-qr-spec](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/40-qr-spec.md) | Tech lead |
| QR再発行で旧 invoice 監視継続 | pass / fail | `tests/security-hardening.test.mjs`, diagnostics lineage | Tech lead |
| exact match paid | pass / fail | `tests/chain-monitor.test.mjs`, `tests/manual-refund-verification.test.mjs` | Tech lead |
| expired 後着金 -> manual review / late payment | pass / fail | `tests/late-arrival-review.test.mjs`, `tests/security-hardening.test.mjs` | Ops + Tech lead |
| 過入金 / 不足入金 / 重複入金 | pass / fail | `tests/chain-monitor.test.mjs`, `tests/server-integration.test.mjs` | Ops + Finance |
| CSV export | pass / fail | `tests/server-integration.test.mjs` SR-13, audit export evidence | Ops |
| audit_log / audit-chain | pass / fail | `npm run test:audit-chain`, `/api/v1/audit-logs/export`, `/api/v1/audit-logs/verify-chain` | Security |
| drift detection | pass / fail | `validate-production-config.json`, `deploy-check.log`, [90-production-validation-plan](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/90-production-validation-plan.md) | Infra |
| evidence sanitization | pass / fail | `validate-evidence-sanitization.json` | Security |
| RPC / reorg / duplicate / restart / dead-letter 疑似障害 | pass / fail | `tests/chain-monitor-dead-letter.test.mjs`, `tests/server-restart-persistence.test.mjs`, `tests/chain-monitor.test.mjs` | Tech lead |
| 権限 / セキュリティ negative | pass / fail | `tests/security-hardening.test.mjs`, `tests/server-integration.test.mjs`, `tests/frontend-security.test.mjs` | Security |
| 相関ログ / monitoring 最低限 | pass / fail | [72-monitoring-alerting](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/72-monitoring-alerting.md), runtime logs, `/metrics` | Ops |
| global / store / terminal kill switch | pass / fail | `tests/security-hardening.test.mjs`, [74-runbook](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/74-runbook.md) | Ops |
| 実機 HashPort 起動 | pending / pass / fail | `docs/production/evidence/<timestamp>/EXT-002-*` または device evidence | Store ops |
| 実JPYC 少額決済 | pending / pass / fail | `docs/production/evidence/<timestamp>/EXT-001-*` と tx hash | Finance + Tech lead |
| FQDN / TLS / nginx | pending / pass / fail | nginx config, public URL capture, TLS check evidence | Infra |
| Go / No-Go sign-off | pending / pass / fail | [87-go-no-go-evidence-matrix](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/87-go-no-go-evidence-matrix.md), approval minutes | Exec / Legal / Ops |

## External Pending
- 実機 HashPort / iOS / Android
- 実JPYC 少額決済
- 公開 FQDN / TLS / nginx 実環境確認
- 店舗スタッフ訓練
- Go / No-Go sign-off

外部依存の正本は [docs/production/BLOCKED_EXTERNAL_VALIDATION.md](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/BLOCKED_EXTERNAL_VALIDATION.md) とする。

## Scope boundary
- MVP accounting output の正本は generic CSV/JSON export。`freee`/`マネーフォワード`/`弥生`/direct API は downstream adapter として扱う。
- MVP の必須 customer payment 導線は QR wallet rail。provider/tap 実運用統合は別スコープであり、未実施でもこの表の MVP Done 判定軸を再定義しない。
- invoice status の canonical 名は `review_required`。`manual_review` は互換 alias としてのみ扱う。

## Done when
- 各項目に `判定・主証跡・owner` が紐づいている。
- external pending が pending のまま分離管理されている。
- release 前の evidence review で、この表だけで不足項目が特定できる。
