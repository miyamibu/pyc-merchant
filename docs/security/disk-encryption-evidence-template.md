# ディスク暗号化確認 証跡テンプレート（disk-encryption-evidence-template）

## 使い方

- 初回確認時、および本番環境変更時（ホスト移行・ディスク交換等）に実施する。
- ファイル名: `DISK-ENC-<ENV>-<YYYYMMDD>.md`（ENV: `production` / `staging` 等）
- 保存先: `docs/production/evidence/<timestamp>/DISK-ENC-<ENV>-<YYYYMMDD>.md`
- コマンド出力をそのまま貼り付ける（DBのデータ内容は貼り付けない）。

---

## 基本情報

| 項目 | 内容 |
|---|---|
| 証跡ID | `DISK-ENC-<ENV>-<YYYYMMDD>` |
| 環境 | production / staging / other |
| ホスト種別 | macOS / Linux (bare metal) / Linux (VM) / Docker host |
| OS / バージョン | |
| 確認日時（UTC） | |
| 確認者氏名・役職 | |
| 承認者氏名・役職 | |

---

## Section A: macOS FileVault（macOS環境の場合）

### A-1: FileVault有効化状態

```bash
# コマンド実行結果を貼り付け
$ sudo fdesetup status
```

出力（貼り付け）:
```
[FileVaultのステータス出力を貼り付け]
```

| 確認項目 | 結果 |
|---|---|
| `FileVault is On.` を確認 | pass / fail |

### A-2: DB格納ディスクの暗号化状態

```bash
# コマンド実行結果を貼り付け
$ diskutil apfs list
$ df -h "${DB_PATH:-./runtime/data/app.db}"
```

出力（貼り付け）:
```
[diskutil / df 出力を貼り付け]
```

| 確認項目 | 結果 |
|---|---|
| DBパスがFileVault有効ボリューム上にある | pass / fail |
| バックアップパスがFileVault有効ボリューム上にある | pass / fail |

---

## Section B: Linux LUKS（Linux環境の場合）

### B-1: LUKS暗号化ボリュームの確認

```bash
# コマンド実行結果を貼り付け
$ lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT
$ sudo dmsetup ls --target crypt
```

出力（貼り付け）:
```
[lsblk / dmsetup 出力を貼り付け]
```

### B-2: DBパスのデバイス・暗号化状態

```bash
$ df -h "${DB_PATH:-./runtime/data/app.db}"
$ lsblk -s [device]
```

出力（貼り付け）:
```
[df / lsblk出力を貼り付け]
```

| 確認項目 | 結果 |
|---|---|
| DBパスのデバイスがLUKS経由 | pass / fail |
| バックアップパスのデバイスがLUKS経由 | pass / fail |

---

## Section C: Docker環境のボリューム確認

```bash
$ docker volume inspect jpyc_runtime 2>/dev/null | jq '.[].Mountpoint'
# または docker-compose.yml のbind mountパスを確認
```

出力（貼り付け）:
```
[docker volume inspect 出力またはbind mountパスを貼り付け]
```

| 確認項目 | 結果 |
|---|---|
| Docker volumeのhostpathが暗号化ストレージ上にある | pass / fail |

---

## Section D: Backup/Restore Drill 結果

### D-1: バックアップ実行

```bash
$ bash scripts/deploy/backup-sqlite.sh
```

出力（バックアップファイルパスのみ貼り付け）:
```
[バックアップファイルパスを貼り付け（DBデータは貼り付けない）]
```

### D-2: Restore Drill 実行

```bash
$ bash scripts/deploy/restore-drill.sh
```

出力（貼り付け）:
```
[restore drill出力を貼り付け（DBデータは含まない）]
```

| 確認項目 | 結果 |
|---|---|
| `quick_check: ok` を確認 | pass / fail |
| audit chain verify が pass | pass / fail |
| 本番DBが変更されていないことを確認 | 確認済み |

### D-3: RPO/RTO計測

| 指標 | 計測値 | 目標 | 結果 |
|---|---|---|---|
| RPO（直近バックアップからの経過時間） | | 1営業日以内 | pass / fail |
| RTO（restore drill所要時間） | | 30分以内 | pass / fail |

---

## 暗号化に関する重要事項の確認

| 事項 | 確認 |
|---|---|
| FileVault/LUKSは停止時・ディスク持ち出し時の保護であり、稼働中アクセス制御の代替でないことを担当者が理解している | 確認済み |
| 稼働中のアクセス制御はアプリの認証・Secret Managerで実施されていることを確認 | 確認済み |
| バックアップも暗号化ストレージ上に保管されていることを確認 | 確認済み |
| 外部保管（クラウド等）の場合は追加暗号化措置の確認 | 該当なし / 確認済み |

---

## 総合判定

| 判定 | 内容 |
|---|---|
| **暗号化確認結果** | pass / fail |
| **restore drill結果** | pass / fail |
| **商用Go可否** | GO / BLOCKED（理由を記載） |

---

## 承認署名

| 役割 | 氏名 | 日時 | 署名/承認ID |
|---|---|---|---|
| 確認実施者 | | | |
| インフラ担当 | | | |
| セキュリティ責任者 | | | |

---

## 保管ルール

- 本証跡を `docs/production/evidence/<timestamp>/` に保存する。
- DBの内容・secret実値を本ファイルに記録しない。
- コマンド出力のみ貼り付ける。
- 証跡は保存期間中は削除しない。
