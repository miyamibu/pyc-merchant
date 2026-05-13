# SQLite OSレベル暗号化確認とBackup/Restore Drill 手順書

## Goal

本番DBファイル（SQLite）がOSレベルの暗号化ストレージ上に存在することを確認し、backup/restore drillを安全に実施して、RPO/RTO目標を満たすことを検証する。

## Context

- DBパス: `DB_PATH`（既定: `./runtime/data/app.db`）
- バックアップパス: `BACKUP_DIR`（既定: `./runtime/backups`）
- SQLite自体にはファイルレベル暗号化がないため、OSレベルのディスク暗号化（FileVault / LUKS）に依存する。
- **重要**: ディスク暗号化はシステム停止時・ディスク持ち出し時の保護であり、**稼働中のアクセス制御やsecret管理の代替ではない**。

## Constraints

- **本番DBを上書きしない**。restore drillは必ず一時ディレクトリで実施する。
- `runtime/`, `data/`, `*.db`, `*.sqlite`, `*.sqlite3` を直接変更しない。
- secret実値を記録しない。

---

## Section 1: macOS FileVault 確認手順

### 1-1: FileVault有効化状態を確認

```bash
# FileVaultのステータスを確認
sudo fdesetup status
# 期待結果: "FileVault is On."

# ボリュームの暗号化状態を確認
diskutil apfs list | grep -A5 "FileVault"
```

### 1-2: DB格納場所がFileVault対象ボリュームにあることを確認

```bash
# DBパスのマウントポイントを確認
df -h "$DB_PATH" 2>/dev/null || df -h ./runtime/data/

# マウントポイントが "/" または "/Volumes/Macintosh HD" 等
# FileVaultが有効なシステムボリュームであることを確認
```

### 1-3: バックアップファイルも暗号化ストレージ上にあることを確認

```bash
df -h "$BACKUP_DIR" 2>/dev/null || df -h ./runtime/backups/
# バックアップが暗号化対象ボリューム上にあることを確認
# 暗号化対象外のボリューム（外部ドライブ・ネットワークドライブ等）への保管は追加の暗号化措置が必要
```

### 1-4: 証跡記録

```bash
# 以下を disk-encryption-evidence-template.md に記録する
sudo fdesetup status >> /tmp/filevault-status.txt
diskutil apfs list >> /tmp/diskutil-output.txt
```

---

## Section 2: Linux LUKS 確認手順

### 2-1: LUKS暗号化ボリュームの確認

```bash
# 暗号化デバイスの一覧
lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT | grep -E "crypt|luks"

# 特定デバイスのLUKS状態を確認
sudo cryptsetup status /dev/mapper/<device_name>

# または
sudo dmsetup ls --target crypt
```

### 2-2: DBパスのマウントポイントと暗号化状態を確認

```bash
# DBパスのデバイスを特定
df -h "$DB_PATH"
mount | grep "$(df "$DB_PATH" | tail -1 | awk '{print $1}')"

# そのデバイスがLUKS経由でマウントされていることを確認
lsblk -s "$(df "$DB_PATH" | tail -1 | awk '{print $1}')"
```

### 2-3: Docker環境での確認

```bash
# docker volume inspectでhostpathを確認
docker volume inspect jpyc_runtime 2>/dev/null | jq '.[].Mountpoint'

# または docker-compose.ymlのvolumeバインドを確認
# bind mountの場合: hostのDBパスが暗号化ストレージ上にあることを上記で確認
```

### 2-4: バックアップファイルも暗号化ストレージ上にあることを確認

```bash
df -h "$BACKUP_DIR"
# 上記と同様にLUKS経由であることを確認
```

---

## Section 3: Backup実行手順

```bash
# 事前確認: DBが存在することを確認
ls -lh "${DB_PATH:-./runtime/data/app.db}"

# バックアップを実行（本番DBは変更しない）
bash scripts/deploy/backup-sqlite.sh

# 出力例: ./runtime/backups/app-20260428T120000Z.sqlite3
# バックアップファイルのパスを確認
ls -lh "${BACKUP_DIR:-./runtime/backups}/app-*.sqlite3" | tail -3
```

---

## Section 4: Restore Drill 実行手順

**本番DBは上書きしない。一時ディレクトリに復元して検証する。**

```bash
# 最新バックアップで restore drill を実行
bash scripts/deploy/restore-drill.sh

# 特定のバックアップファイルを指定する場合
bash scripts/deploy/restore-drill.sh ./runtime/backups/app-<TIMESTAMP>.sqlite3
```

### restore-drill.sh が実施すること

1. 指定バックアップファイルを `mktemp -d` の一時ディレクトリにコピー
2. `PRAGMA quick_check` を実行（`ok` であることを確認）
3. `sqlite_master` でテーブル数 ≥ 5 であることを確認
4. `scripts/verify-audit-chain.mjs` でaudit chain整合性を確認
5. 一時ディレクトリパスとrestoreパスを出力（本番DBは変更しない）

### 期待する出力例

```
restore_drill_temp_dir=/tmp/jpyc-restore-drill-XXXXXX
restore_drill_db=/tmp/jpyc-restore-drill-XXXXXX/restored-app.db
```

### PRAGMA quick_checkとaudit chain verify

```bash
# 手動でquick_checkを実行する場合
node - "/tmp/restored.db" <<'NODE'
const Database = require("better-sqlite3");
const db = new Database(process.argv[2], { readonly: true });
const result = db.pragma("quick_check", { simple: true });
console.log("quick_check:", result);
const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get();
console.log("table_count:", tables.count);
db.close();
NODE

# audit chain verify
DB_PATH=/tmp/restored.db node scripts/verify-audit-chain.mjs
```

---

## Section 5: RPO / RTO 基準

| 指標 | 目標値 | 確認方法 |
|---|---|---|
| RPO（目標復旧時点） | 1営業日以内 | 直近バックアップのタイムスタンプを確認 |
| RTO（目標復旧時間） | 30分以内 | restore drill の所要時間を計測 |

```bash
# drill所要時間を計測
time bash scripts/deploy/restore-drill.sh
```

---

## Section 6: 暗号化に関する重要事項

| 事項 | 内容 |
|---|---|
| **保護範囲** | FileVault/LUKSは電源OFF時・ディスク持ち出し時のデータ保護 |
| **保護されないケース** | システム稼働中・ログイン中・正規アクセスによるデータアクセス |
| **稼働中のアクセス制御** | アプリのPIN認証・セッション管理・環境変数のSecret Manager管理で実施 |
| **バックアップの暗号化保管** | バックアップファイルも暗号化ストレージまたはアクセス制御された保管先へ |
| **外部保管の場合** | 外部ストレージ・クラウドに保管する場合は追加の暗号化措置が必要（要設定: 法務確認） |

---

## Done when

- FileVault/LUKSの有効化を手順通りに確認した。
- DB格納パスとバックアップパスが暗号化ストレージ上にあることを確認した。
- restore drillが `quick_check: ok` かつaudit chain検証をpassした。
- 所要時間がRTO目標（30分）を下回ることを確認した。
- 証跡を `docs/production/evidence/<timestamp>/` に保存した。

## Failure-handling

- `quick_check` が `ok` 以外を返した場合: バックアップを追加作成し、直前の正常バックアップに切り替える。DBの整合性問題として `docs/73-incident-response.md` に報告する。
- audit chain verifyが失敗した場合: 整合性問題として記録し、法務・監査に報告する。
- RTO超過の場合: 手順の改善・自動化を検討する。
- 暗号化未確認の場合: **商用Goをブロックし**、環境担当者が暗号化を有効化してから再確認する。
