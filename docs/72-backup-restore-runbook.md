# 72. Backup / Restore Runbook

## Goal
SQLite ベースの売上台帳と監査ログを、安全にバックアップし、破壊せずに restore drill を実施できるようにする。

## Paths
- DB: `DB_PATH` 既定 `./runtime/data/app.db`
- Backup dir: `BACKUP_DIR` 既定 `./runtime/backups`

## Backup
- 実行コマンド:
  - `bash scripts/deploy/backup-sqlite.sh`
- 方式:
  - `better-sqlite3` の backup API を使い、タイムスタンプ付き `app-<UTC>.sqlite3` を生成する。
- 想定頻度:
  - 営業日中は日次
  - 実証初週は営業開始前と営業終了後

## Restore drill
- 実行コマンド:
  - `bash scripts/deploy/restore-drill.sh`
  - 特定ファイルを使う場合: `bash scripts/deploy/restore-drill.sh ./runtime/backups/app-<UTC>.sqlite3`
- 挙動:
  - 一時ディレクトリへ復元
  - `PRAGMA quick_check`
  - [audit chain verify](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/scripts/verify-audit-chain.mjs)
- 本番DBは上書きしない。

## RPO / RTO baseline
- RPO 目安: 1営業日以内
- RTO 目安: 30分以内
- 実証期間中は restore drill 結果を release evidence に残す。

## Evidence
- 保存先:
  - `docs/production/evidence/<timestamp>/backup.log`
  - `docs/production/evidence/<timestamp>/restore-drill.log`
- 記録項目:
  - backup file path
  - backup UTC timestamp
  - restore temp dir
  - quick check 結果
  - audit chain verify 結果

## 関連文書（2026-04-27 追加）

| 文書 | 内容 |
|---|---|
| `docs/security/sqlite-encryption-and-restore-drill.md` | OSレベル暗号化確認（FileVault/LUKS）・backup実行・restore drillの詳細手順・RPO/RTO計測 |
| `docs/security/disk-encryption-evidence-template.md` | 暗号化確認証跡テンプレート（macOS/Linux/Docker/restore drill結果を記録） |

## Cautions
- `cp` だけで live DB を複製しない。
- backup file は暗号化ストレージまたはアクセス制御された保管先へ移動する。
- restore drill 成功前に `GO` を出さない。

## Done when
- backup と restore drill をコマンド化できる。
- 実行結果を evidence に残せる。
