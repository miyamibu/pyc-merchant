# Phase 1 成果物: 法務・運用形態スコープ（10-legal-scope）

## Goal
本番化で最初に確定すべき法務スコープを明文化し、技術実装の前提を固定する。

## Context
- 日本では電子決済手段等取引業・電子決済等取扱業に関する制度が開始済み。
- 運用形態で必要対応が大きく変わる。

## Constraints
- 本文書は法的助言ではない。
- 最終判断は法務責任者・外部専門家が行う。
- 未確定項目は `外部承認が必要` とする。

## 想定運用モデル
| モデル | 内容 | 主な論点 |
|---|---|---|
| Model A | 自社店舗が自社売上としてJPYC受領 | 規約、返金方針、会計、本人確認要否 |
| Model B | 他店舗向け決済基盤提供 | 登録要否、加盟店契約、AML/CFT、苦情処理 |
| Model C | 返金代行/資金管理を伴う運用 | 資産管理責任、鍵管理、内部統制 |

## 主要論点
- 事業者の法的位置づけ（受領主体、仲介主体、代行主体）。
- 顧客資産・加盟店資産の取り扱い責任。
- AML/CFT上の実務フロー（異常取引検知、保存、報告）。
- トラブル時責任分界（誤送金、期限後着金、重複送金）。
- 利用規約・プライバシーポリシー・返金ポリシー・店頭掲示文。

## 公式情報（確認日: 2026-04-19）
- 金融庁「電子決済手段等取引業・電子決済等取扱業を営もうとするみなさまへ」
  - https://www.fsa.go.jp/common/shinsei/dendai/dentori.html
- 金融庁 2026-02-03 公表（電子決済手段等取引業者に関する制度更新情報）
  - https://www.fsa.go.jp/news/r7/sonota/20260203/20260203.html
- JPYC株式会社プレスリリース（資金移動業者登録・JPYC発行）
  - https://prtimes.jp/main/html/rd/p/000000283.000054018.html

## 関連文書（2026-04-27 追加）

本スコープを実装するための詳細文書が作成されました。

| 文書 | 内容 |
|---|---|
| `docs/legal/jpyc-legal-classification-decision-pack.md` | 法的分類決定パック（運用モデルA/B/C比較・登録要否質問票・LEGAL_GATE_APPROVAL_REF形式・fail-closed条件） |
| `docs/legal/terms-draft.md` | 利用規約ドラフト（法務レビュー前） |
| `docs/legal/privacy-policy-draft.md` | プライバシーポリシードラフト（法務レビュー前） |
| `docs/legal/refund-policy-draft.md` | 返金ポリシードラフト（法務レビュー前） |
| `docs/legal/customer-consent-requirements.md` | 顧客同意要件・同意UI仕様・同意記録APIフォーマット |
| `docs/storefront/payment-notice-poster.md` | 店頭掲示物ドラフト |
| `docs/storefront/posting-evidence-template.md` | 掲示証跡テンプレート |

## 判定ゲート
| Gate | 条件 | 現在 |
|---|---|---|
| L-1 | 運用モデルA/B/C確定 | 外部承認が必要 |
| L-2 | 登録/届出要否確認 | 外部承認が必要 |
| L-3 | 規約・ポリシー草案レビュー | BLOCKED |
| L-4 | 返金責任分界定義 | BLOCKED |

## Done when
- 運用モデルが1つに決まり、法務責任者の承認がある。
- 規約/ポリシー/掲示の必要項目が確定。
- Phase 2設計へ進んで良い条件が明文化される。

## Validation
- `docs/11-regulatory-questions.md` の質問に回答が埋まる。
- `docs/open-questions.md` の Q-001, Q-002, Q-006 が承認済みになる。

## Failure handling
- L-1 または L-2 未承認の場合、実決済実装を開始しない。
