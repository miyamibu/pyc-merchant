# 61. Secret Management

## Goal
機密値をコードから分離し、監査可能な運用にする。

## Required Secrets
- `APP_SECRET`
- `PAY_LINK_SIGNING_KEYS` / `SSE_SIGNING_KEYS`
- `TERMINAL_ENTRY_SIGNING_KEYS` / `SESSION_SIGNING_KEYS`
- `SERVICE_HMAC_KEYS` / `AUDIT_ROOT_SIGNING_KEYS`
- `SERVICE_INGEST_SECRET`
- `METRICS_SECRET`
- (将来) `REOWN_PROJECT_ID`
- (将来) RPC認証情報

## Rules
- repository へ平文保存しない。
- `.env` はローカル検証用のみ。
- 本番環境は Secret Manager 管理（**外部承認が必要**）。
- 期限付きローテーション手順をRunbook化。

## 関連文書（2026-04-27 追加）

| 文書 | 内容 |
|---|---|
| `docs/security/service-ingest-secret-rotation-runbook.md` | `SERVICE_INGEST_SECRET` の定期ローテーション手順（Plan A: 計画停止、Plan B: 侵害緊急対応） |
| `docs/security/service-ingest-secret-compromise-playbook.md` | 侵害確認時の封じ込め・新secret設定・影響調査・通知・復旧条件 |
| `docs/security/secret-rotation-drill-evidence-template.md` | ローテーション実施証跡テンプレート（secret実値は記録しない） |

## Done when
- insecure default ではサーバー起動を拒否。
- CIはテスト用固定値のみを使用。
