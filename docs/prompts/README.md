# Prompt Index

## Goal
JPYC 商用 closeout に必要な Codex prompt を一箇所で参照できるようにする。

## Context
- external pending の canonical 判断基準は `docs/production/BLOCKED_EXTERNAL_VALIDATION.md`。
- closeout prompt は実行手順だけでなく、`pending` を正直に維持するための出力・検証・失敗時処理を含める。

## Constraints
- Prompt は `Goal`、`Context`、`Constraints`、`Done when` を必須とする。
- Prompt は `Output format`、`Validation method`、`Failure-handling behavior` を必須とする。
- 実送金・実機・公開ホスト・店舗訓練は external activity であり、未実施時は `pending` のまま記録する。

## Done when
- closeout 実行者がこの index から EXT prompt に迷わず到達できる。
- prompt が `BLOCKED_EXTERNAL_VALIDATION` の canonical close 条件と矛盾しない。

## Prompt Index
- [EXT Closeout Prompts (EXT-001..EXT-004)](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/prompts/ext-closeout-prompts.md)
- [Codex Full Codebase Review Prompt](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/prompts/codex-full-codebase-review-prompt.md)
- [Codex Remediation And Readiness Prompt](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/prompts/codex-remediation-and-readiness-prompt.md)
- [Codex Repo-Internal Closeout Polish Prompt](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/prompts/codex-repo-internal-closeout-polish-prompt.md)
- Canonical closeout status source: [Blocked External Validation](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/production/BLOCKED_EXTERNAL_VALIDATION.md)
- [Claude Commercial Closeout Instructions](/Users/mimac/Desktop/JPYC決済端末_MVP_UIUX/docs/prompts/claude-commercial-closeout-instructions.md)
