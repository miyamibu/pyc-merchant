# Phase 2 成果物: ウォレット対応計画（22-wallet-support-plan）

## Goal
対応ウォレット範囲、接続方式、検証計画を定義し、サポート負荷と品質リスクを管理する。

## Context
現状のウォレットボタンはUIのみで、接続ロジックがない。

## Constraints
- 対応ウォレットはTierで分ける。
- Tier-1 以外を本番Go条件に含めない。
- 実機検証なしで「対応済み」と宣言しない。

## サポートTier
| Tier | 対象 | 期待レベル |
|---|---|---|
| Tier-1 | HashPort Wallet + WalletConnect経由主要ウォレット | 本番Go対象 |
| Tier-2 | MetaMask Mobile / Browser | GA後サポート |
| Tier-3 | その他WalletConnect対応ウォレット | ベストエフォート |

## 接続方式
- スマホ: WalletConnect URI を介した接続。
- ブラウザ拡張: EIP-1193 provider を介した接続（必要に応じて）。
- 接続失敗時: 明確なリカバリ導線を表示。

## UX要件（最低限）
- 未インストール時: インストール案内表示。
- 未接続時: 接続ステップ表示。
- 別チェーン選択: 正しいチェーンへ誘導。
- ガス不足/残高不足: 具体的な次アクション表示。
- 署名拒否: 再試行/キャンセル導線。
- tx pending長期化: 状態説明と問い合わせ導線。

## テストマトリクス（ドラフト）
| ケース | 期待結果 | Tier-1必須 |
|---|---|---|
| 正常送金 | `confirming -> paid` | Yes |
| 不足送金 | `review_required` | Yes |
| 過入金 | `review_required` | Yes |
| 重複送金 | `review_required` | Yes |
| 期限後送金 | `review_required` | Yes |
| 別チェーン | エラー + レビュー導線 | Yes |
| 別トークン | エラー + レビュー導線 | Yes |
| 署名拒否 | 失敗表示 + 再試行可能 | Yes |

## Done when
- Tier-1対応ウォレットが確定。
- Tier-1全ケースの実機テスト項目が完成。

## Validation
- `docs/90-test-plan.md`（後続）に本表が引き継がれる。

## Failure handling
- Tier-1の未検証ケースが残る場合、本番Go判定を出さない。
