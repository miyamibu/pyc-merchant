# Conditional-Go運用ガードレール（89-conditional-go-guardrails）

## Goal
限定運用を行う場合でも、法務・会計・セキュリティの未承認を持ち込まず、運用範囲を厳密に制限する。

## Preconditions
- `LEGAL_GATE_APPROVED`, `AML_POLICY_APPROVED`, `PRIVACY_POLICY_APPROVED`, `APPI_POLICY_APPROVED` はすべて true。
- JPYC contract / confirmations / backscan の approval ref が揃っている。
- 未完了なのは実運用証跡や限定ローンチ評価のような release evidence に限る。

## Envelope
- 期間は最大30日。
- 対象店舗と対象端末は signed minutes に記載する。
- 1取引上限は `MAX_INVOICE_AMOUNT_JPY` 以下。
- 日次総額上限は `DAILY_STORE_AMOUNT_CAP_JPY` 以下。
- 日次件数上限は `DAILY_STORE_INVOICE_CAP` 以下。

## Allowed and prohibited
| Category | Allowed | Prohibited |
|---|---|---|
| 取引規模 | env 上限内の取引 | env 上限を超える取引 |
| 店舗展開 | minutes に記載した店舗のみ | 追加店舗の無断展開 |
| 返金 | approval 済みフロー + verification | 未検証の成功扱い |
| 障害対応 | runbook 準拠 | 口頭だけの復旧判断 |

## Auto-stop conditions
- 重大インシデント発生
- 上限超過
- dead-letter の abandoned 増加
- signed minutes に記載した終了日時の到来

## Done when
- conditional launch の境界が minutes と env の両方で確認できる。
