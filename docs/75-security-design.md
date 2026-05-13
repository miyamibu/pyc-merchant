# 75. Security Design

## Goal
本番前に必要な最低セキュリティ設計を文書化する。

## Controls
- HMAC service auth: timestamp + jti + payload hash
- replay guard: `service_replay_guards`
- idempotency: `idempotency_records`
- audit hash chain: `audit_logs.prev_hash/entry_hash`
- RBAC + operation permissions
- two-person approval for refund
- PIN lockout persistence

## Gaps (外部承認が必要)
- WAF / DDoS 防御
- 秘密鍵管理方式（HSM/MPC/custody）
- 法務要件に応じたログ保管年数

## Done when
- `/api/v1/audit-logs/verify-chain` が継続的に通る。
