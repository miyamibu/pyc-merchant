# Secret Rotation / 緊急対応 証跡テンプレート（secret-rotation-drill-evidence-template）

## 使い方

- ローテーションまたは緊急対応を実施するたびに本テンプレートをコピーする。
- ファイル名: `ROTATION-<YYYYMMDDHHMMSS>-<type>.md`（type: `planned` または `emergency`）
- 保存先: `docs/production/evidence/<timestamp>/ROTATION-<type>.md`
- **secret実値はこのファイルに記録しない。Secret ManagerのバージョンIDのみ記録する。**

---

## 基本情報

| 項目 | 内容 |
|---|---|
| ドリルID / インシデントID | `ROTATION-<YYYYMMDDHHMMSS>` |
| 種別 | `planned`（計画的） / `emergency`（緊急・漏洩対応） |
| 対象secret | `SERVICE_INGEST_SECRET` |
| 開始日時（UTC） | |
| 完了日時（UTC） | |
| downtime時間 | |
| 実施者氏名・役職 | |
| 承認者氏名・役職 | |

---

## 事前確認

| チェック項目 | 結果 | 確認者 |
|---|---|---|
| 新secretをSecret Managerに登録済み | pass / fail | |
| ローテーション前の `/readyz` が healthy | pass / fail | |
| ログにsecret値が出ていないことを確認 | pass / fail | |
| メンテナンス時間帯の設定（計画的の場合） | 設定済み / N/A | |

---

## Secret 管理情報（値は記録しない）

| 項目 | 内容 |
|---|---|
| 旧secret管理ID（Secret ManagerのバージョンID） | |
| 旧secretの無効化完了日時（UTC） | |
| 新secret管理ID（Secret ManagerのバージョンID） | |
| 新secretの有効化完了日時（UTC） | |

---

## 実施手順チェックリスト

| Step | 内容 | 完了時刻（UTC） | 結果 |
|---|---|---|---|
| 1 | 事前確認（readyz / ログ確認） | | pass / fail |
| 2 | chain-monitor停止 | | 完了 |
| 3 | 新secretをSecret Managerに登録・有効化 | | 完了 |
| 4 | app停止 | | 完了 |
| 5 | 環境変数更新（Secret Manager経由） | | 完了 |
| 6 | app起動・readyz確認 | | pass / fail |
| 7 | chain-monitor起動 | | 完了 |
| 8 | smoke check（readyz / metrics / ログ） | | pass / fail |

---

## Smoke Check 結果

```
# /readyz レスポンス（JSONを貼り付け）


# ログ確認結果（secretがログに出ていないことの確認）
grep結果: 0件（secretが出ていない）

# chain-monitorログ（直近50行のサマリー）
```

---

## Replay Guard 確認

| 確認項目 | 結果 |
|---|---|
| 不審なJTI・serviceIDがないことを確認 | pass / fail |
| replay attack疑いの記録なし | あり / なし |

---

## ロールバック実施有無

| 項目 | 内容 |
|---|---|
| ロールバック実施 | あり / なし |
| ロールバック理由（実施した場合） | |
| ロールバック完了時刻 | |

---

## 緊急対応セクション（種別=emergency の場合のみ記入）

| 項目 | 内容 |
|---|---|
| 発覚日時（UTC） | |
| 封じ込め完了日時（UTC） | |
| 侵害疑いの発端・露出経路 | |
| 調査対象期間 | |
| 偽ingest件数（確認済み） | |
| 影響を受けたinvoice件数 | |
| 偽確定したinvoice件数 | |
| review_requiredに移行したinvoice件数 | |
| 顧客通知実施 | あり / なし |
| 店舗通知実施 | あり / なし |
| 法務責任者への報告 | 完了日時を記録 |
| 監査担当への報告 | 完了日時を記録 |
| APPI上の通知要否（法務判断） | 要 / 不要 / 確認中 |
| 復旧承認者 | 法務責任者・セキュリティ責任者の氏名 |
| 復旧完了日時 | |
| 再発防止策 | |

---

## 次回ローテーション予定

| 項目 | 内容 |
|---|---|
| 次回予定日 | |
| 担当者（予定） | |

---

## 承認署名

| 役割 | 氏名 | 日時 | 署名/承認ID |
|---|---|---|---|
| 実施者 | | | |
| セキュリティ責任者 | | | |
| 法務責任者（緊急時） | | | |
| 経営承認（緊急時・規模による） | | | |

---

## 保管ルール

- 本証跡を `docs/production/evidence/<timestamp>/` に保存する。
- secret実値・パスワード・認証情報を本ファイルに記録しない。
- 証跡は保存期間中は削除しない。
- 本ファイルはgitにコミットしない（`docs/production/evidence/` は `.gitignore` または別管理を検討）。
