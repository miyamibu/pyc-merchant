# SERVICE_INGEST_SECRET ローテーション Runbook

## Goal

`SERVICE_INGEST_SECRET` を安全に切り替え、稼働中のchain-monitor・serverの継続性を確保しながら証跡を残す。

## Context

- `SERVICE_INGEST_SECRET` はchain-monitorがserverへ支払いイベントをingestするためのHMAC秘密情報。
- server.mjs と chain-monitor.mjs の両方が同一の値を使用する。
- **現行実装は単一secretのみ対応**: 旧secretの受け入れ猶予期間（dual-key期間）は実装されていない。したがって、ローテーションには短時間のdowntimeが発生する。
- `SERVICE_INGEST_SECRET` 長さ ≥ 32 字、insecure値は起動拒否。

## Constraints

- secret実値を本文書・gitリポジトリ・ログに記録しない。
- placeholder のみ使用: `<OLD_SECRET_ID>`, `<NEW_SECRET_ID>`, `<新しいsecret>` 等。
- protected pathを変更しない。

---

## A. 通常ローテーション（計画的）

### 前提条件

- [ ] 新しいsecretを生成済み（本番Secret Manager上で管理）
- [ ] 実施者・承認者を決定済み
- [ ] ローテーション証跡テンプレートを用意済み（`secret-rotation-drill-evidence-template.md`）
- [ ] メンテナンス時間帯を設定済み（可能なら低トラフィック時間帯）

### 影響範囲

| コンポーネント | 影響 |
|---|---|
| `chain-monitor` | 再起動が必要。停止中は新しいオンチェーン支払いの検知が止まる。既存インボイスのポーリングが止まる。 |
| `server (app)` | 再起動が必要。停止中はすべてのAPIが応答しない。 |
| 進行中の支払い | confirming/payment_detected 状態の支払いは停止中も台帳に残る。再起動後に監視が再開される。 |

### 手順

#### Step 1: 事前確認

```bash
# 現在の稼働状態を確認
curl -sf "$APP_HOST/readyz" | jq .

# replay guard TTL等の設定を確認（secretログが出ていないことを確認）
# NOTE: ログにSERVICE_INGEST_SECRETの値が出ていないことをgrepで確認
grep -r "SERVICE_INGEST_SECRET" /var/log/app/ 2>/dev/null | grep -v "is not set\|is weak\|FATAL" | wc -l
# 上記コマンドの出力が0であること
```

#### Step 2: chain-monitorを停止

```bash
# docker-composeの場合
docker compose stop chain-monitor

# または直接プロセス停止
# supervisorctl stop jpyc-chain-monitor
```

#### Step 3: 新しいsecretを本番Secret Managerに登録

**Secret Managerで実施（このrunbookには値を記録しない）:**
- 新しいsecretを生成: `openssl rand -hex 32`（生成はSecure環境で実施）
- Secret Managerに登録・有効化
- 新しいsecretのID/バージョンをメモ（値ではなく管理ID）

#### Step 4: server（app）を停止

```bash
docker compose stop app
```

#### Step 5: 環境変数を更新

**本番Secret Managerまたはenv管理システムで `SERVICE_INGEST_SECRET` を新しい値に更新する。gitへのコミットは不可。**

#### Step 6: appを起動・ヘルスチェック

```bash
docker compose up -d app

# 起動確認（最大60秒待機）
for i in $(seq 1 12); do
  curl -sf "$APP_HOST/readyz" && break
  sleep 5
done

# readyzのapprovals.serviceIngests確認
curl -sf "$APP_HOST/readyz" | jq '.approvals // empty'
```

#### Step 7: chain-monitorを起動

```bash
docker compose up -d chain-monitor

# ログで正常起動を確認（SECRET漏洩がないことを確認）
docker compose logs --tail=50 chain-monitor | grep -v "SERVICE_INGEST_SECRET"
```

#### Step 8: 動作確認（smoke check）

```bash
# /readyz で全体ステータス確認
curl -sf "$APP_HOST/readyz" | jq .

# /metrics で payment_events の ingest が再開されていることを確認
# （新しい支払いが発生した場合のみ確認可能）
curl -sf "$APP_HOST/api/v1/admin/metrics" -H "Authorization: ..."

# replay guard が機能していることを確認
# （chain-monitorから次のHMACリクエストが通ることをログで確認）
docker compose logs --tail=30 chain-monitor
docker compose logs --tail=30 app | grep "ingest\|payment_event"
```

#### Step 9: 証跡記録

`secret-rotation-drill-evidence-template.md` に以下を記録:
- 実施者
- 承認者
- 開始時刻・完了時刻
- 旧secret管理ID（値ではない）
- 新secret管理ID（値ではない）
- smoke check結果
- ログ確認結果（secretがログに出ていないことの確認）

---

## B. 漏洩疑い時の緊急ローテーション

### 緊急ローテーションのトリガー

- secretがgit・ログ・チャット等に露出した可能性
- 不審なingestリクエスト（replay attackの疑い）
- 関係者の離職・アクセス権失効後のリスク評価

### 緊急手順（利便性より containment 優先）

#### E-Step 1: 支払い機能を即時無効化（kill switch）

```bash
# payments_disabled フラグをDBに直接設定（APIで行う場合）
curl -X POST "$APP_HOST/api/v1/admin/payments/disable" \
  -H "Authorization: ..." \
  -H "Content-Type: application/json" \
  -d '{"reason": "emergency_secret_rotation"}'
```

#### E-Step 2: chain-monitorを即時停止

```bash
docker compose stop chain-monitor
```

#### E-Step 3: 旧secretを即時無効化（Secret Manager）

**Secret Managerで旧secretバージョンを無効化・削除する（値を記録しない）。**

#### E-Step 4: 以降は通常ローテーション Step 3〜9 に従う

ただし:
- 最速で実施する
- 承認者への即時連絡必須
- `service-ingest-secret-compromise-playbook.md` の調査手順を並行実施

#### E-Step 5: 影響期間の調査

`service-ingest-secret-compromise-playbook.md` のSection 3を参照。

---

## ロールバック条件と手順

| 条件 | 対応 |
|---|---|
| 新secretでappが起動しない | 旧secretに戻す（Secret Manager）→ 再起動 |
| chain-monitorとappの接続が確立しない | ログ・secretの一致確認。mismatechなら再度Step 3から |
| smoke checkで`/readyz`がunhealthy | ログを確認し、原因を特定してから再試行 |

---

## 失敗時対応

- app/chain-monitorが起動しない場合は **`PAYMENTS_DISABLED=true`** 状態で運用し、原因調査後に再試行する。
- 問題が解決しない場合は `docs/73-incident-response.md` に従ってインシデント対応に移行する。

---

## 証跡項目（secret実値は一切記録しない）

| 項目 | 内容 |
|---|---|
| 実施者 | 氏名・役職 |
| 承認者 | 氏名・役職 |
| 開始時刻（UTC） | |
| 完了時刻（UTC） | |
| 旧secret管理ID | Secret ManagerのバージョンIDのみ |
| 新secret管理ID | Secret ManagerのバージョンIDのみ |
| downtime時間 | |
| smoke check結果 | pass / fail + 詳細 |
| ログ確認結果 | secretがログに出ていないことを確認 |
| replay guard確認 | 正常 / 異常 |
| 次回ローテーション予定 | |

---

## Done when

- chain-monitorとappが新secretで正常起動している。
- `/readyz` が healthy を返す。
- 監査ログにingest eventが記録されている（次の支払いイベントで確認）。
- secretがログに漏洩していないことを確認した。
- 証跡テンプレートに記録が完了した。

## Validation method

- `npm run security:destructive` が通ること（本runbookがsecret実値を含まないこと）。
- `/readyz` の `approvals` で legal/AML/privacy/APPI の状態が変わっていないこと。
