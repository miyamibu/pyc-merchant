# 承認計画（80-approval-plan）

## Goal
production / commercial closeout に必要な承認を、runtime gate と signed evidence の両方で閉じる。

## Approval model
このリポジトリでは、承認済みかどうかを次の二層で管理する。
1. deployment env に入る gate / reference
2. signed minutes / release record から辿れる approval evidence

どちらかが欠ける場合、production は fail-closed のままとする。

## Approval targets
| Gate | Scope | Canonical env / record | Validation path | Evidence owner | Record location |
|---|---|---|---|---|---|
| A-1 | 法務境界 | `LEGAL_GATE_APPROVED`, `LEGAL_GATE_APPROVAL_REF` | `GET /readyz`, `npm run commercial:validate` | 法務責任者 | `docs/88`, `docs/97` |
| A-2 | AML方針 | `AML_POLICY_APPROVED`, `AML_POLICY_APPROVAL_REF` | `GET /readyz`, `npm run commercial:validate` | 法務責任者 + 会計責任者 | `docs/88`, `docs/97` |
| A-3 | プライバシー方針 | `PRIVACY_POLICY_APPROVED`, `PRIVACY_POLICY_APPROVAL_REF` | `GET /readyz`, `npm run commercial:validate` | 法務責任者 | `docs/88`, `docs/97` |
| A-4 | APPI運用 | `APPI_POLICY_APPROVED`, `APPI_POLICY_APPROVAL_REF`, `APPI_RETENTION_POLICY_REF`, `APPI_DELETION_PROCEDURE_REF`, `APPI_DISCLOSURE_PROCEDURE_REF` | `GET /readyz`, `npm run commercial:validate` | 法務責任者 | `docs/88`, `docs/97` |
| A-5 | JPYC contract / decimal policy | `APPROVED_JPYC_TOKEN_CONTRACT`, `JPYC_CONTRACT_APPROVAL_REF`, `TOKEN_DECIMALS`, `JPYC_BASE_UNIT_SCALE` | `node scripts/production-validation/validate-production-config.mjs`, `npm run commercial:validate` | 技術責任者 | `docs/88`, `docs/97` |
| A-6 | confirmations / backscan policy | `REQUIRED_CONFIRMATIONS`, `MIN_REQUIRED_CONFIRMATIONS`, `CONFIRMATIONS_POLICY_APPROVAL_REF`, `MONITOR_BACKSCAN_BLOCKS`, `MIN_MONITOR_BACKSCAN_BLOCKS`, `BACKSCAN_POLICY_APPROVAL_REF` | production startup fail-closed, `GET /readyz`, `npm run commercial:validate` | 技術責任者 | `docs/88`, `docs/97` |
| A-7 | refund / non-custodial運用 | refund verification evidence, separation-of-duties signoff | automated tests, runbook, signed review | セキュリティ責任者 + 運用責任者 | `docs/88`, `docs/97` |
| A-8 | release verdict | machine verdict + signed minutes + release record | `npm run commercial:validate`, approval meeting | 四責任者 | `docs/88`, `docs/97` |

## Execution order
1. approval ref を発行し、release record 下書きに紐付ける。
2. `.env.production` を更新し、`npm run production:validate:env` と `/readyz` で runtime gate を確認する。
3. `EXT-001..004` と必要なら `POC-001..003` の evidence owner / due date を確定する。
4. `npm run commercial:validate` を実行し、machine verdict を `docs/88` と `docs/97` に転記する。
5. approval meeting で human verdict を確定する。

## Constraints
- approval ref を placeholder のまま残さない。
- external pending を approval ref だけで pass にしない。
- machine verdict と人間の決裁記録をずらさない。

## Done when
- A-1〜A-8 の evidence が `docs/88` と `docs/97` で一致している。
- production startup validation、`/readyz`、commercial verdict が矛盾していない。
