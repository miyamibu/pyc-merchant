# 92. Legal / AML / APPI Runtime Gates

## Goal
法務・AML・プライバシー承認が未完了な状態で危険機能を有効化しない。

## Runtime gates
| Scope | Gate | Required reference |
|---|---|---|
| Legal | `LEGAL_GATE_APPROVED=true` | `LEGAL_GATE_APPROVAL_REF` |
| AML | `AML_POLICY_APPROVED=true` | `AML_POLICY_APPROVAL_REF` |
| Privacy | `PRIVACY_POLICY_APPROVED=true` | `PRIVACY_POLICY_APPROVAL_REF` |
| APPI | `APPI_POLICY_APPROVED=true` | `APPI_POLICY_APPROVAL_REF`, `APPI_RETENTION_POLICY_REF`, `APPI_DELETION_PROCEDURE_REF`, `APPI_DISCLOSURE_PROCEDURE_REF` |

## Fail-closed behavior
- production では上記の gate と reference が揃わないと起動しない。
- `LEGAL_GATE_APPROVED=false` の場合:
  - refund execute の `external_signer` / `custody_provider` を `503 LEGAL_GATE_NOT_APPROVED` で拒否。
- `AML_POLICY_APPROVED=false` の場合:
  - `AML_HIGH_VALUE_THRESHOLD_JPY` 以上の請求作成を拒否。
- `PRIVACY_POLICY_APPROVED=false` または `APPI_POLICY_APPROVED=false` の場合:
  - audit export を `503 PRIVACY_POLICY_NOT_APPROVED` で拒否。

## APPI data map (minimum)
- wallet address
- invoice id / store id / terminal id
- payment events (tx hash, chain metadata)
- IP address (request logs / audit metadata)
- audit logs / CSV exports

## Retention and disclosure operating rule
- 保持期間そのものは `APPI_RETENTION_POLICY_REF` が指す承認済み文書を正本とする。
- 削除依頼の受付・実行手順は `APPI_DELETION_PROCEDURE_REF` が指す承認済み手順書を正本とする。
- 開示依頼の受付・本人確認・回答手順は `APPI_DISCLOSURE_PROCEDURE_REF` が指す承認済み手順書を正本とする。
- これらの reference がない場合、production は起動しない。

## Data subject operational minimum
1. 受付担当は依頼種別を `開示`, `訂正`, `削除`, `利用停止` のいずれかで記録する。
2. 本人確認または正当な代理権確認を実施する。
3. 対象データの抽出範囲を wallet address / invoice / terminal / audit logs まで明示する。
4. 実行内容と承認者を audit log に記録する。
5. 法令または不正対策上の保全が必要な場合は、その理由と保全期間を記録する。

## Approval record contents
- 承認者
- 承認日
- 適用範囲
- 改定履歴
- 参照先文書の保管場所
- 次回見直し日

## Readiness checks
- `/readyz` の `approvals` で legal / AML / privacy / APPI の状態を確認できる。
- secret 値そのものは readiness に出さない。

## Suspicious activity log
`suspicious_activity_logs` に以下を記録:
- high amount invoice
- duplicate payment event
- abnormal over-refund request
- unverified manual refund record

## Done when
- 各 gate の責任者と approval ref が release record に記載され、production 設定と一致する。
