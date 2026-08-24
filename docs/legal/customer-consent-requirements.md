# 顧客同意要件（customer-consent-requirements）

> **【法務レビュー前ドラフト】**
> 本文書は同意UIの設計・実装基準を定めます。法的有効性の最終確認は法務責任者が行ってください。

---

## Goal

支払い前に顧客が利用規約・プライバシーポリシー・返金ポリシーを確認し、明示的に同意してから支払い操作へ進む仕組みを定義する。

## Context

- 顧客は `mobile.html` でJPYC支払いを行う。
- 同意前はウォレット起動・支払い情報コピー・手動送金案内操作をブロックする。
- 同意記録はサーバー側audit_logsに記録する（audit trail）。

## Constraints

- 個人情報・秘密情報を同意記録に含めない。
- 新しいフロントエンド依存を追加しない（既存HTML/CSS/JSのみ）。
- settlement export contractに影響しない。

---

## 1. 同意が必要なタイミング

| 状況 | 同意要否 |
|---|---|
| 請求状態が `issued`, `open` などWAITING_STATUSES | **必須** |
| 請求状態が `paid`, `settled` など完了状態 | 不要（支払い操作自体が無効） |
| 請求状態が `expired`, `cancelled` | 不要（支払い操作自体が無効） |

状態名の補足:
- canonical は `review_required`。
- `manual_review` は互換 alias として受けても、表示・運用文言は `review_required` に正規化して扱う。

---

## 2. 同意ブロックの必須表示内容

同意ブロックは以下をすべて含む必要があります。

### 2-1. ポリシーへのリンク

| ポリシー | リンク先（公開後に更新） | バージョン識別子 |
|---|---|---|
| 利用規約 | [要設定: 公開URL] | `terms_version: "draft-v1"` |
| プライバシーポリシー | [要設定: 公開URL] | `privacy_version: "draft-v1"` |
| 返金ポリシー | [要設定: 公開URL] | `refund_policy_version: "draft-v1"` |

### 2-2. 必須警告事項（チェック前に目視確認させる）

- チェーン・トークン・金額・送金先の確認義務
- 二重送金・分割送金は手動確認対象になること
- 誤チェーン・誤トークン・誤アドレス送金は返金できない/困難な場合があること
- ガス代（POL〔旧MATIC〕等）がウォレットに必要なこと
- 秘密鍵・シードフレーズを入力しないこと（スタッフは要求しない）

### 2-3. チェックボックス

- ラベル: 「上記の内容と利用規約・プライバシーポリシー・返金ポリシーを確認しました」
- チェック前はウォレット起動・コピー操作ボタンが `disabled`
- チェック後のみ操作可能になる

---

## 3. 同意記録のフォーマット（サーバー側audit_logs）

同意後、フロントエンドは以下のデータをサーバーに送信します。サーバーは `audit_logs` に記録します。

| フィールド | 内容 | 個人情報 |
|---|---|---|
| `invoice_id` | 対象請求ID | なし（識別子） |
| `terms_version` | 利用規約バージョン（例: `"draft-v1"`） | なし |
| `privacy_version` | プライバシーポリシーバージョン | なし |
| `refund_policy_version` | 返金ポリシーバージョン | なし |
| `consented_at` | 同意時刻（ISO 8601） | なし |

記録**しないもの**:
- IPアドレス（audit_logs の `ip_address` フィールドは request ip として既存のAPPI scope内だが、consent専用レコードへの記録は要設定: 法務確認要）
- ウォレットアドレス（この時点では未知）
- ユーザー識別情報

---

## 4. 同意記録のAudit_log エントリ形式

```json
{
  "actor_type": "customer_anonymous",
  "actor_id": "<invoice_id>",
  "action": "customer_policy_consent",
  "target_type": "invoice",
  "target_id": "<invoice_id>",
  "after_state": {
    "terms_version": "draft-v1",
    "privacy_version": "draft-v1",
    "refund_policy_version": "draft-v1",
    "consented_at": "<ISO timestamp>"
  }
}
```

---

## 5. APIエンドポイント仕様

```
POST /api/v1/public/invoices/:invoiceId/consent
```

| 項目 | 内容 |
|---|---|
| 認証 | 署名付きURL（sig + exp + nonce）による検証 |
| レート制限 | 既存 `PUBLIC_RATE_LIMIT` に準じる |
| リクエストボディ | `{ terms_version, privacy_version, refund_policy_version }` |
| レスポンス（成功） | `{ ok: true, recorded_at: "<ISO>" }` |
| レスポンス（エラー） | 既存 `jsonError` 形式 |
| 副作用 | `audit_logs` へのINSERT のみ（invoice状態は変えない） |
| settlement影響 | なし |

---

## 6. Fail-safeルール

| 条件 | 挙動 |
|---|---|
| サーバー側consent記録が失敗 | フロントエンドはエラーを表示するが、支払い操作はローカル同意後に許可（記録失敗で支払いを完全ブロックしない） |
| `LEGAL_GATE_APPROVED=false` | consent endpoint自体は動作するが、商用利用は別途ブロック |
| consent記録前に支払いボタン押下 | `disabled` 属性でブロック |
| ページリロード | 同意状態はリセット（再度チェック必要）。サーバー側にはセッションをまたいだ同意状態を持たせない |

---

## 7. 法務承認条件

- 利用規約・プライバシーポリシー・返金ポリシーが法務承認を受けた後に、リンク先URLを実際の公開URLに更新する。
- それまでのドラフトリンクには「法務レビュー前ドラフト」と明記する。
- 同意UIの公開は `LEGAL_GATE_APPROVED=true` かつ `PRIVACY_POLICY_APPROVED=true` の環境で行う。

---

## Done when

- 顧客が同意チェックなしにウォレット起動・コピー操作できない。
- 同意ブロックに規約リンク・リスク警告・チェックボックスがある。
- サーバー側にaudit記録が残る。
- テストが通る。
