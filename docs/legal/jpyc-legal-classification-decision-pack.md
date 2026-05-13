# JPYC法的分類 決定パック（jpyc-legal-classification-decision-pack）

> **【法務レビュー前ドラフト】**
> 本文書はClaude Codeが法務責任者・外部専門家の判断を支援するために作成した比較整理資料です。法的結論を断定しません。最終判断・承認は必ず法務責任者および外部専門家が行ってください。公開・商用利用は承認後に限定します。

---

## Goal

法務責任者がGo/No-Go判断できる最低限の情報パックを提供する。Claude Codeは分類を断定しない。承認者が判断できる構造を用意する。

## Context

- 本プロダクトは非カストディ型JPYCマーチャントOps / Settlement Layer。
- 秘密鍵・seed phraseのサーバー側保管・署名代行・custody・返金代行は扱わない。
- JPYC（ERC-20, 資金移動業型）を対価として受け取る決済端末機能を提供する。

## Constraints

- Claude Codeは法的結論を断定しない。
- 未確定項目は `外部承認が必要` とする。
- 法務承認がない場合、商用Goは `BLOCKED`。

---

## 1. 想定運用モデルの整理

| モデル | 内容 | 該当する可能性 |
|---|---|---|
| **Model A** | 自社店舗が自社売上としてJPYC受領。決済基盤は自社運用のみ。 | PoC・限定実証 |
| **Model B** | 他店舗向けに決済基盤を提供。JPYC受領を加盟店の代わりに処理または中継する。 | 商用展開 |
| **Model C** | 返金代行・資金管理・プール保持を伴う運用。JPYC一時保有や代理送金を含む。 | 対象外（非カストディ境界により禁止） |

**現在の本プロダクト位置づけ（仮）:** Model A または Model B の判断は外部承認が必要。Model Cは非カストディ境界により実装禁止。

---

## 2. 規制カテゴリ比較表

| カテゴリ | 根拠法令 | 登録/届出 | 主な要件 | 本プロダクトとの関係 |
|---|---|---|---|---|
| **前払式支払手段** | 資金決済法 第3章 | 届出（第5条）または登録 | 発行保証金、利用者保護措置 | JPYCを自社が発行する場合に該当。本プロダクトは発行者ではなく受領者（加盟店）側。 |
| **資金移動業** | 資金決済法 第3章の2 | 登録必須 | AML/CFT、利用者資産保全、記録保存、報告 | JPYC株式会社が登録取得済み（要最新確認）。本プロダクトが顧客JPYC「移動」を代理・中継する場合は論点。 |
| **暗号資産交換業** | 資金決済法 第3章の2 （暗号資産） | 登録必須 | AML/CFT、本人確認（KYC）、記録・報告 | JPYCが資金移動業型（法定通貨建て電子記録移転権利）の場合、暗号資産交換業には非該当の可能性あり。外部承認が必要。 |
| **電子決済手段等取引業** | 資金決済法 第3章の3 | 登録必須 | 利用者保護、AML/CFT | JPYCが「電子決済手段」に該当する場合、仲介・交換等に登録が必要になる可能性。外部承認が必要。 |
| **電子決済等取扱業** | 資金決済法 第2章の2等 | 登録必須 | 特定の役務範囲、業務制限 | 仕向け送金・受取等の仲介が業に該当するかどうかは運用モデルに依存。外部承認が必要。 |

---

## 3. 本プロダクトがしていること・していないこと

### していること（実装済み）

| 行為 | 詳細 |
|---|---|
| 請求インボイス生成 | 金額・期限・受取アドレスを含む請求書を生成し、署名付きURLで顧客に提示する |
| オンチェーン送金検知 | チェーンモニターがJPYC送金トランザクションを検知し、インボイスと突合する |
| 支払状態管理 | issued → confirming → paid → settled のステート遷移を管理する |
| 審査キュー | 二重送金・分割送金・誤チェーン等を `review_required` として人間審査に回す |
| 返金記録 | 外部ウォレットで実行した返金を記録・検証する（返金自体は代行しない） |
| 監査ログ | 全操作をハッシュチェーン付き監査ログに記録する |

### していないこと（非カストディ境界）

| 禁止事項 | 理由 |
|---|---|
| 秘密鍵・seed phraseのサーバー側保管 | 非カストディ設計 |
| 顧客またはJPYCのサーバー側署名代行 | 非カストディ設計 |
| 顧客JPYCの一時保有・プール保持 | 非カストディ設計 |
| 返金の自動代行・自動執行 | 非カストディ設計 |
| 加盟店への決済清算代行（送金代行） | Model C相当、現行実装対象外 |

---

## 4. 登録/届出要否の確認質問（法務責任者への質問票）

以下の質問は法務責任者・外部専門家に提出し、回答を `LEGAL_GATE_APPROVAL_REF` に記録してください。

| QID | 質問 | 回答形式 | 現状 |
|---|---|---|---|
| LQ-01 | 本運用（Model A / B）において、電子決済手段等取引業の登録は必要か | 要/不要 + 根拠条文 | 外部承認が必要 |
| LQ-02 | 本運用において、電子決済等取扱業の登録は必要か | 要/不要 + 根拠条文 | 外部承認が必要 |
| LQ-03 | JPYCが「電子決済手段」（資金決済法37条の2）に該当するか | 該当/非該当 + 根拠 | 外部承認が必要 |
| LQ-04 | JPYCが「暗号資産」に該当するか（2号該当性） | 該当/非該当 + 根拠 | 外部承認が必要 |
| LQ-05 | 加盟店がJPYCを受け取る行為（Model A）は何らかの業登録を要するか | 要/不要 + 条件 | 外部承認が必要 |
| LQ-06 | 他店舗向けに本基盤を提供する場合（Model B）は何らかの業登録を要するか | 要/不要 + 条件 | 外部承認が必要 |
| LQ-07 | 返金記録のみを行い、実行は外部ウォレットで行う場合、返金代行業務に該当するか | 該当/非該当 + 根拠 | 外部承認が必要 |
| LQ-08 | AML/CFT上、KYCが不要になる金額閾値は何か | 閾値 + 根拠 | 外部承認が必要 |
| LQ-09 | 監査ログ・取引記録の保存年限要件は何か | 年限 + 根拠法令 | 外部承認が必要 |
| LQ-10 | JPYC株式会社の資金移動業者登録の最新状態は何か（要URL確認） | 登録番号 + 確認日 | 外部承認が必要 |

---

## 5. LEGAL_GATE_APPROVAL_REF に記録すべき承認文書IDの形式

`LEGAL_GATE_APPROVAL_REF` は `.env.production` に設定し、runtime gate が読み取ります。

### 推奨フォーマット

```
LEGAL-YYYY-MMDD-NNN
```

例: `LEGAL-2026-0501-001`

### 承認文書に含めるべき情報

| 項目 | 内容 |
|---|---|
| 文書ID | `LEGAL-YYYY-MMDD-NNN` 形式 |
| 承認日 | ISO 8601形式 |
| 承認者氏名・役職 | 法務責任者または外部専門家 |
| 適用範囲 | Model A/B の別、対象店舗、対象期間 |
| 結論サマリー | 「登録不要と判断」「●●の条件で登録不要」等 |
| 根拠条文・資料 | 法令条項番号、金融庁通達URL、確認日 |
| 次回見直し日 | |
| 保管場所 | `docs/production/evidence/<ID>/` または法務フォルダ |

### AML / Privacy / APPI の承認REF形式（同様）

```
AML-YYYY-MMDD-NNN
PRIVACY-YYYY-MMDD-NNN
APPI-YYYY-MMDD-NNN
```

---

## 6. 法務承認がない場合のFail-closed条件

| Gate | 未承認時の挙動 |
|---|---|
| `LEGAL_GATE_APPROVED=false` | 商用Go **BLOCKED**。refund execute系APIが `503 LEGAL_GATE_NOT_APPROVED` を返す。 |
| `AML_POLICY_APPROVED=false` | `AML_HIGH_VALUE_THRESHOLD_JPY` 以上の請求作成を拒否。 |
| `PRIVACY_POLICY_APPROVED=false` | audit export が `503 PRIVACY_POLICY_NOT_APPROVED` を返す。 |
| `APPI_POLICY_APPROVED=false` | audit export が `503 PRIVACY_POLICY_NOT_APPROVED` を返す。APPI_RETENTION_POLICY_REFなしでは起動しない（production）。 |
| `LEGAL_GATE_APPROVAL_REF` 未設定 | production 起動時に FATAL エラー。 |

---

## 7. 参照情報（確認日を更新してください）

| 資料 | URL | 確認日（最終） |
|---|---|---|
| 金融庁: 電子決済手段等取引業 | https://www.fsa.go.jp/common/shinsei/dendai/dentori.html | 2026-04-19 |
| 金融庁: 資金移動業者登録一覧 | https://www.fsa.go.jp/menkyo/menkyoj/shikin_idou.pdf | 要再確認 |
| 金融庁: 暗号資産交換業者登録 | https://www.fsa.go.jp/policy/virtual_currency02/index.html | 要再確認 |
| 個人情報保護委員会: APPI guidelines | https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/ | 要再確認 |

---

## Done when

- LQ-01〜LQ-10 に法務責任者の署名付き回答がある。
- `LEGAL_GATE_APPROVAL_REF` 形式の文書IDが確定し、release recordに記載される。
- 法務承認がない場合のfail-closed条件が env 設定で機能していることを確認済み。

## Validation method

- `/readyz` の `approvals.legal` が `true` になることを確認する。
- `docs/11-regulatory-questions.md` の RQ-01〜RQ-10 と本パックの LQ-01〜LQ-10 の回答が整合する。

## Failure-handling behavior

- LQ-01〜LQ-07 のいずれかが未回答の場合、商用Go は `BLOCKED`。
- 承認参照文書IDなしで `LEGAL_GATE_APPROVED=true` に設定しない。
