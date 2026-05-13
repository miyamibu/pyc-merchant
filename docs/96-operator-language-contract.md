# Operator Language Contract

## Goal
店舗スタッフとお客様が暗号資産の内部状態を知らなくても、JPYCの請求・支払い確認・確認待ち・返金証跡・日次締めを安全に運用できる表示語彙を固定する。

## Context
内部状態や監視用語は、開発・管理者・監査では必要だが、店頭スタッフやお客様にそのまま出すと誤操作につながる。この文書と `src/operator-language.mjs` を、店舗運用向けの表示語彙の source of truth とする。

## Constraints
- ノンカストディ境界を弱めない。アプリが返金送金を実行するような表現をしない。
- 店頭スタッフ向けには、商品引渡し可否、次の安全な操作、店長確認の要否を優先する。
- お客様向けには、金額、ネットワーク、送金先、期限、二重送金禁止、秘密鍵/シードフレーズ禁止を優先する。
- 管理者向けだけ、内部状態名を併記してよい。

## Display Mapping

| Internal / technical | Staff display | Admin display | Customer display |
| --- | --- | --- | --- |
| `pending` / `issued` / `open` | お支払い待ち | issued / お支払い待ち | お支払い待ち |
| `payment_detected` | 確認中 | payment_detected / 入金検知 | 確認中 |
| `confirming` | 確認中 | confirming / 確認中 | 確認中 |
| `paid` | 支払い確認済み | paid / 店頭完了 | 支払い確認済み |
| `manual_review` / `review_required` | 店長確認が必要 | review_required / 確認待ち | お支払い内容を確認中 |
| `expired` | 期限切れ | expired / 期限切れ | この請求は期限切れです |
| `settled` | 締め反映済み | settled / 締め済み | 原則非表示 |
| `cancelled` | 無効 | cancelled / 無効 | この請求は無効です |
| fixed QR | 端末入口QR | static entry URL | 原則非表示 |
| current invoice URL | この会計の支払いURL | current invoice URL | 支払いページURL |
| atomic amount | 非表示 | 原子単位 / atomic amount | 非表示 |
| worker | 状態更新 | monitor worker | 非表示 |

## Staff Action Policy

| State | 商品引渡し | Next action |
| --- | --- | --- |
| お支払い待ち | まだ渡さない | QRを読み取ってもらい、支払い確認済みになるまで待つ |
| 確認中 | まだ渡さない | 二重送金を止め、自動更新を待つ |
| 支払い確認済み | 渡してOK | 商品を渡してよい。必要なら確認書を案内 |
| 店長確認が必要 | 店長確認まで保留 | 追加送金させず、店長/管理者を呼ぶ |
| 期限切れ | まだ渡さない | 古い画面から送金しないよう案内し、新請求を作成 |
| 締め反映済み | 渡してOK | 追加操作不要 |
| 無効 | まだ渡さない | 新しい請求を作成するか別決済へ切り替える |

## Forbidden User-Facing Terms

Store/customer-facing deliverables must not show these terms as operation instructions:

- `review_required`
- `manual_review`
- raw `paid`
- raw `settled`
- `atomic amount`
- `token_contract`
- `RPC`
- `worker`
- `固定QR` when it implies reusable payment QR
- `秘密鍵を入力`
- `シードフレーズを入力`

## Required Safety Copy

Store staff:

```text
絶対にしないこと

- お客様の秘密鍵・シードフレーズを聞かない
- お客様のウォレットを代わりに操作しない
- お客様のスマホを預からない
- 送金先を口頭だけで読み上げて案内しない
- 画面外のアドレスへ送るよう案内しない
- 支払い確認済みになる前に商品を渡さない
- 確認待ち中に追加送金を促さない
```

Customer:

```text
店舗スタッフが秘密鍵・シードフレーズを聞くことはありません。
絶対に入力・共有しないでください。
```

## Done when
- `src/operator-language.mjs` and staff/customer materials use this mapping.
- Staff/customer artifacts avoid forbidden terms except where explicitly quoted in internal validation.
- Staff can decide whether to hand over goods without reading crypto details.
- Customer can avoid double payment and seed/private-key sharing without reading internal implementation notes.

## Validation method
- Run `tests/operator-os-language.test.mjs`.
- Run generated artifact tofu/forbidden-term scan.
- Review public HTML for role-appropriate language.

## Failure-handling behavior
- If a new state has no safe action mapping, default to “店長確認が必要” and do not auto-settle or imply goods can be handed over.
