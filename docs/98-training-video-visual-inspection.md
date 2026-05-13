# Training Video Visual Inspection

## Goal
MP4研修動画の日本語表示、tofu glyph、危険な店頭/顧客向け用語漏れを、人間の目視証跡付きで検収する。

## Context
HTMLと生成インデックスは自動検査できるが、既存MP4の画面内テキストはOCR未導入のため自動で完全検査しない。動画の検収完了は、チェックリストとスクリーンショット証跡が揃った時だけ主張できる。

## Constraints
- MP4内の文字検証を未実施のまま「完了」と書かない。
- 秘密鍵、シードフレーズ、実PIN、本番credentialを動画や証跡に含めない。
- 外部実機・実JPYC・公開TLSを伴う動画は、別途外部検証証跡として扱う。

## Checklist Fields
各MP4ごとに以下を記録する。

- filename
- scenario
- duration
- Japanese text visible: pass/fail
- tofu/□ visible: pass/fail
- important labels readable: pass/fail
- staff/customer unsafe terms visible: pass/fail
- reviewer
- reviewed_at
- screenshot evidence path
- notes

## Done when
- `artifacts/operator-os/2026-04-29/video-visual-inspection-checklist.md` の全行が reviewer / reviewed_at / screenshot evidence path 付きで pass/fail 記入済み。
- tofu または危険語が見つかった動画は差し替え、再生成、または未完了扱いにする。

## Validation method
- `tests/operator-os-language.test.mjs` が checklist の存在と training index の注意文を確認する。
- 人間レビュー担当者が代表フレームまたはスクリーンショットを証跡フォルダに保存する。

## Failure-handling behavior
- checklist が `PENDING_HUMAN_REVIEW` の間は、MP4視覚検収を完了扱いにしない。
- 動画内に tofu glyph または禁止語が見つかった場合、そのMP4を training complete として扱わない。
