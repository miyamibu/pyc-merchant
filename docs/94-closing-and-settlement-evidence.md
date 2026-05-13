# 94. Closing and Settlement Evidence

## Goal
日次締め、CSV出力、監査ログ、invoice 単位照合の証跡を、会計確認用に同じ形式で残す。

## Required evidence
- business date
- settlement ID
- paid invoice count
- review invoice IDs
- total billed JPY
- total paid JPYC
- CSV export file
- audit log export
- audit hash-chain verify 結果

## Reconciliation checklist
- invoice 単位で billed / paid / review を照合した
- payment events と invoice status が一致した
- refund verification 記録を確認した
- `review_required` 残件を確認した
- 管理者承認を記録した

## Evidence file examples
- `settlement-YYYY-MM-DD.csv`
- `audit-export-YYYY-MM-DD.json`
- `audit-chain-verify.json`
- `closing-review-notes.md`
