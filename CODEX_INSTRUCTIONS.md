# CODEX_INSTRUCTIONS.md

## Goal
Codex 作業を明示的な運用スキャフォールドで統一し、non-custodial 境界、監査可能性、外部証跡の正直な扱いを維持する。

## Context
- この repo は non-custodial な JPYC Merchant Ops / Settlement Layer であり、秘密鍵や署名権限を保持しない。
- 商用 closeout には `EXT-001..004` の external evidence が必要で、repo 内の自動検証 pass だけでは代替できない。
- external pending の canonical source は `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`。
- Codex 向けの reusable prompt は `docs/prompts/` で管理する。

## Constraints
- Prompt / instruction 本文には必ず `Goal`、`Context`、`Constraints`、`Done when` を含める。
- Prompt / instruction 本文には `Output format`、`Validation method`、`Failure-handling behavior` を明記する。
- non-custodial 境界を越える実装（秘密鍵保管、署名代行、資産カストディ）は追加しない。
- `docs/production/BLOCKED_EXTERNAL_VALIDATION.md` の `Required` 項目は、実証跡が揃うまで `pending` のまま保持する。推測や仮値で `pass` にしない。
- 破壊的変更は AGENTS.md の destructive operations policy に従い、保護対象データ・証跡の削除は明示承認なしで行わない。

## Done when
- Codex が参照すべき運用前提（non-custodial、external pending honesty、非破壊ポリシー）がこのファイルで明示されている。
- `docs/prompts/README.md` から closeout prompt 一覧に到達できる。
- EXT closeout 実行時に、実行者が `pending` / `pass` 判定と証跡要件を誤解しない。
