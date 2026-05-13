# Phase 3 成果物: 状態遷移定義（33-state-machine）

## Goal
請求・レビュー・返金の状態遷移を正規化し、二重計上や誤完了を防ぐ。

## Context
- 現状はフロント内モック遷移のみ。
- 本番ではDB遷移が唯一の正本になる。

## Constraints
- 無効遷移は禁止し、APIで `INVALID_STATE_TRANSITION` を返す。
- `paid` への遷移条件はチェーン照合 + 確認数条件を満たすこと。
- 期限後着金は `review_required` とし、自動 `paid` にしない。
- canonical 状態名は `review_required` とし、`manual_review` は互換 alias としてのみ扱う。

## 1. Invoice 状態
- `draft`
- `issued`
- `payment_detected`
- `confirming`
- `paid`
- `expired`
- `review_required`
- `cancelled`

補足:
- 旧UI/旧連携で `manual_review` が来た場合は `review_required` と同義に正規化して扱う。

## 2. Invoice 遷移表
| From | To | 条件 |
|---|---|---|
| `draft` | `issued` | 請求作成完了 |
| `issued` | `payment_detected` | 対象tx検知 |
| `payment_detected` | `confirming` | token/宛先/金額一次照合OK |
| `confirming` | `paid` | 必要確認数到達 + 照合継続OK |
| `issued` | `expired` | 期限到達時点で検知なし |
| `payment_detected` | `review_required` | 不足/過入金/重複/誤条件 |
| `confirming` | `review_required` | reorg/差分異常 |
| `expired` | `review_required` | 期限後着金 |
| `issued` | `cancelled` | スタッフキャンセル |

## 3. Review 状態
- `open`
- `in_progress`
- `resolved`
- `rejected`

遷移:
| From | To | 条件 |
|---|---|---|
| `open` | `in_progress` | 担当アサイン |
| `in_progress` | `resolved` | 処理完了 |
| `in_progress` | `rejected` | 無効ケース確定 |
| `resolved` | `open` | 再調査（管理者のみ） |

## 4. Refund 状態
- `requested`
- `approved`
- `executing`
- `succeeded`
- `failed`
- `cancelled`

遷移:
| From | To | 条件 |
|---|---|---|
| `requested` | `approved` | 承認者チェック完了 |
| `approved` | `executing` | セキュアワーカー投入 |
| `executing` | `succeeded` | 返金tx確定 |
| `executing` | `failed` | tx失敗/期限超過 |
| `requested` | `cancelled` | 申請取り下げ |

## 5. 不変条件（Invariants）
- `paid` の請求は `amount_jpyc_received >= amount_jpyc_expected` かつ照合一致。
- `paid` 後の新規入金イベントは `review_required` へ分岐。
- 同一 `(chain_id, tx_hash, log_index)` は1回のみ有効処理。
- `review_required` の請求はスタッフ単独で `paid` に戻せない。

## 6. 期限・時刻ルール
- 期限判定はサーバーUTC。
- 端末表示時刻は参考情報。
- NTPずれ時は端末警告を出しつつサーバー判定を優先。

## Done when
- すべての状態に遷移条件が定義される。
- 不変条件がDB/API設計へ反映できる。

## Output format
- テーブル形式で遷移定義を記述。

## Validation method
- `docs/31-db-schema.md` の `status` 列と一致。
- `docs/32-api-spec.md` のAPI遷移条件に反映可能。

## Failure-handling behavior
- 不変条件違反検知時は `critical alert` を上げ、該当請求を `review_required` 固定にする。
