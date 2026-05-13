# Phase 3 成果物: 冪等性・監査設計（34-idempotency-and-audit）

## Goal
二重実行・重複計上・監査欠損を防ぐための冪等性戦略と監査ログ戦略を定義する。

## Context
- 店頭決済では再送、タイムアウト、ネットワーク断で同一リクエスト重複が起きる。
- 監査ログ欠損は金融運用上の重大リスクになる。

## Constraints
- 金融状態変更APIは冪等キー必須。
- 監査ログは「後から再生成」しない（同時記録）。
- 監査ログは原則追記のみ、編集不可。

## 1. 冪等性ポリシー
### 対象API
- `POST /invoices`
- `POST /invoices/{id}/cancel`
- `POST /payments/events:ingest`
- `POST /refunds`
- `POST /refunds/{id}/approve`
- `POST /refunds/{id}/execute`
- `POST /settlements/daily:close`

### 実装方針
- `Idempotency-Key` + `actor_id` + `endpoint` をキーに保存。
- 初回成功時のレスポンスを保存し、再送には同一レスポンスを返す。
- 異なるpayloadで同一キーが来た場合は `IDEMPOTENCY_CONFLICT`。
- TTLは業務要件に応じて設定（例: 24h〜72h）。

## 2. チェーンイベント重複防止
- 一意識別子: `(chain_id, tx_hash, log_index, event_type)`。
- `log_index` が取れない場合は `(chain_id, tx_hash, event_type)` を暫定キーにし、後続同期で補正。
- `reorg` 受信時は `tx_confirmed` を巻き戻し、監査ログへ理由を記録。

## 3. トランザクション境界
- 1つの金融状態変更トランザクション内で以下を同時処理:
1. 対象行ロック
2. 状態遷移
3. 監査ログ追加
4. 必要なら通知イベント作成

- いずれか失敗したらロールバック。

## 4. 監査ログ必須項目
- `who`: actor_type, actor_id
- `when`: created_at
- `what`: action, target_type, target_id
- `why`: reason / note
- `trace`: request_id, idempotency_key
- `diff`: before, after

## 5. 監査対象イベント（最小セット）
- 請求作成/取消/期限処理
- 入金検知/確定/巻戻し
- レビュー作成/更新/解決
- 返金申請/承認/実行/失敗
- 端末セッション開始/終了/失効
- 重要設定変更（TTL、対応チェーン、停止フラグ）

## 6. 運用チェック
- 監査ログ件数と金融イベント件数の整合チェックを日次で実施。
- 欠損検知時は自動アラート。
- 改ざん検知のため、ログ整合ハッシュまたはWORM保管を検討。

## Done when
- 冪等キー運用が全更新APIで定義される。
- 二重計上防止制約がDB定義へ落ちる。
- 監査イベントの必須項目が固定化される。

## Output format
- 設計規約文書（実装コードなし）。

## Validation method
- `docs/31-db-schema.md` の制約と一致。
- `docs/32-api-spec.md` の更新系APIへ適用可能。

## Failure-handling behavior
- 冪等衝突や監査欠損を検知した場合、対象操作を `FAIL-CLOSED`（保留/レビュー）に倒す。
