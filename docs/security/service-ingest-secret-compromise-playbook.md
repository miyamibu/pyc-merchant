# SERVICE_INGEST_SECRET 漏洩・侵害対応 Playbook

## Goal

`SERVICE_INGEST_SECRET` の漏洩または侵害疑いが発生した際に、迅速に封じ込め（containment）を行い、影響を調査し、安全に復旧する。

## Context

- `SERVICE_INGEST_SECRET` が漏洩した場合、攻撃者は正規のchain-monitorになりすまして偽の支払いイベントをingestできる可能性がある。
- replay guardは同一JTIの再利用を防ぐが、新しいJTIを使った偽ingestは防げない。
- 支払いの即時無効化（kill switch）が最優先。

## Constraints

- secret実値をこのplaybookや証跡に記録しない。
- 調査中も protected pathを変更しない。
- 顧客・店舗・法務・監査への通知は判断ゲートを経て行う。

---

## Section 1: 即時封じ込め（発覚から15分以内）

### Step 1-1: 支払い受付を完全停止

```bash
# 支払い機能を即時無効化
curl -X POST "$APP_HOST/api/v1/admin/payments/disable" \
  -H "Authorization: ..." \
  -H "Content-Type: application/json" \
  -d '{"reason": "secret_compromise_investigation"}'

# 確認
curl -sf "$APP_HOST/api/v1/admin/payments" -H "Authorization: ..." | jq '.payments_disabled'
```

### Step 1-2: chain-monitorを即時停止

```bash
docker compose stop chain-monitor
# または: supervisorctl stop jpyc-chain-monitor
```

### Step 1-3: 旧secretを即時revoke（Secret Manager）

**Secret Managerで旧secretバージョンを無効化する（値をここに記録しない）。**

### Step 1-4: 関係者への即時連絡

| 連絡先 | タイミング | 内容 |
|---|---|---|
| セキュリティ責任者 | 即時 | 侵害疑い・封じ込め実施済み |
| 法務責任者 | 30分以内 | 侵害の可能性・調査開始 |
| 経営者 | 状況により | 事業影響の報告 |

---

## Section 2: 新secretへの切り替え

`service-ingest-secret-rotation-runbook.md` のSection A（通常ローテーション）Step 3〜9を実施。

**ただし**: 封じ込め完了・調査進行中は支払い再開をしない。`PAYMENTS_DISABLED` のまま調査を優先する。

---

## Section 3: 影響期間の調査

### 3-1: 侵害疑いのタイムラインを特定

```bash
# audit_logsからingest系イベントを抽出（DB readonlyで確認）
# NOTE: 実際のDB操作は管理者ツールまたは backup restore drill 経由で行う
# 本番DBを直接上書きしない

# 例（backup restore drill後の一時DBで実行）:
# SELECT created_at, actor_id, action, target_id, ip_address
# FROM audit_logs
# WHERE action LIKE '%ingest%' OR action LIKE '%payment_event%'
# ORDER BY created_at DESC
# LIMIT 500;
```

### 3-2: 偽イベント注入の調査

| 確認項目 | 方法 |
|---|---|
| 通常のchain-monitor ID以外のactor_idでのingest | audit_logsを確認 |
| 同一JTIの多重使用（replay） | service_replay_guardsテーブルを確認 |
| 不審なIPアドレスからのingest | audit_logsのip_addressを確認 |
| 侵害期間中のpayment_events | payment_eventsテーブルを確認 |
| 侵害期間中に作成・変更されたinvoice | invoicesテーブルを確認 |

### 3-3: オンチェーンイベントとの突合

```bash
# 侵害期間中にpayment_detectedまたはconfirmingになったinvoiceを特定
# 対応するtx hashをブロックエクスプローラーで確認
# 実際のオンチェーン送金と突合し、偽ingestによる誤承認がないか確認
```

### 3-4: 偽ingest注入疑いが確認された場合

| 被疑内容 | 対応 |
|---|---|
| 偽のpayment_detectedイベント | 対象invoiceをreview_requiredに移行・手動審査 |
| 偽の確認・確定 | 影響を受けた取引の特定・顧客・店舗への通知判断へ |
| 偽の返金記録 | 不正な返金実行の有無を確認（非カストディのため自動実行はないが記録の改ざんを確認） |

---

## Section 4: replay guard確認

```bash
# service_replay_guardsテーブルで侵害期間中のJTIを確認
# 正規のchain-monitor以外のサービスIDがないかを確認
# 同一ペイロードハッシュで複数JTIが存在しないかを確認
```

---

## Section 5: 顧客・店舗・法務・監査への通知判断

### 通知要否の判断ゲート

| 条件 | 対応 |
|---|---|
| 偽ingestによる誤支払い確定が確認された | 顧客・店舗への個別通知を検討。法務判断必須。 |
| 偽ingestが疑われるが確定していない | 法務・監査と協議の上で方針決定。 |
| 偽ingestの証拠がなく、漏洩元が封じ込められた | 法務判断の上で通知要否を決定。 |
| 金融庁・監査機関への報告要否 | 法務責任者が判断。外部専門家に確認。 |

### 個人情報保護法（APPI）上の通知要否

- 漏洩した情報にウォレットアドレス・IPアドレス等の個人関連情報が含まれる場合、APPI上の報告・通知義務が生じる可能性がある。法務責任者に即時確認する。

---

## Section 6: 復旧判定

復旧（支払い再開）の条件:

- [ ] 新secretで app・chain-monitor が正常起動している
- [ ] `/readyz` が healthy を返す
- [ ] 侵害期間中の全ingestイベントの調査が完了している
- [ ] 偽ingestによる誤確定がない、またはすべて審査対象に移行した
- [ ] 法務責任者・セキュリティ責任者が復旧承認に署名した

```bash
# 支払い再開
curl -X POST "$APP_HOST/api/v1/admin/payments/enable" \
  -H "Authorization: ..." \
  -H "Content-Type: application/json" \
  -d '{"reason": "compromise_investigation_complete"}'
```

---

## 証跡テンプレート（このファイルとは別に記録）

`secret-rotation-drill-evidence-template.md` の「緊急対応セクション」に以下を追記:

| 項目 | 内容 |
|---|---|
| 発覚日時（UTC） | |
| 封じ込め完了日時（UTC） | |
| 対応実施者 | |
| 承認者（法務・セキュリティ） | |
| 旧secret管理ID | （値は記録しない） |
| 侵害疑いの発端 | （露出経路の仮説） |
| 調査対象期間 | |
| 偽ingest件数 | |
| 影響を受けた invoice 件数 | |
| 顧客通知実施有無 | |
| 法務・監査通知実施有無 | |
| 復旧日時 | |
| 再発防止策 | |

---

## Done when

- 新secretで正常稼働している。
- 侵害期間の影響調査が完了し、結果が記録されている。
- 偽確定があった場合、すべてreview_requiredに移行し審査対象になっている。
- 法務・セキュリティ責任者が復旧承認している。
- 証跡が `docs/production/evidence/<timestamp>/` に保存されている。

## Failure-handling

- 調査中に偽ingestによる誤確定を発見した場合は、直ちに影響インボイスをreview_requiredに移行し、法務に報告する。
- ブロックチェーン上の不正送金（顧客から不正アドレスへの誘導等）が疑われる場合は、直ちに法務・捜査機関への相談を検討する。
