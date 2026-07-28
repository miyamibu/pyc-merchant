# 60. Auth and Permissions

## Goal
`staff/manager/admin` を操作別権限へ展開し、重要操作を分離する。

## Session
- 端末ログインAPI: `terminalCode + staffPin + staffName（任意）`。端末UIは担当者特定のため`staffName`を必須入力とする。
- PIN照合結果が0件または複数件の場合は、担当者名や照合件数を漏らさず同一の`401 UNAUTHORIZED`で拒否する。0件のみPIN失敗回数へ加算し、複数一致は端末全体をlockoutさせず管理上の曖昧性としてfail-closedに扱う。
- 成功時は`staff_name`、`effective_permissions`、`expires_at`を返し、UIは実効権限が不明な操作をfail-closedで隠す。
- TTL失効: `SESSION_TTL_SEC`
- 強制失効: `/api/v1/terminal-sessions/:id/revoke`
- セッションは Bearer token のみで扱い、cookie session を前提にしない。

## Permission Model
- `invoice.create`, `invoice.read`
- `review.read`, `review.update`
- `accounting.adjustment.read`, `accounting.adjustment.create`, `accounting.adjustment.approve`
- `refund.request`, `refund.approve`, `refund.execute`
- `payment.ingest.manual`
- `settlement.close`
- `staff.manage`, `terminal.manage`
- `session.read`, `session.revoke`
- `audit.read`, `audit.export`
- `monitor.read`
- `payments.control`
- `address_pool.manage`

## Two-Person Rules
- `requested_by !== approved_by`
- (設定有効時) `approved_by !== executed_by`
- 会計調整は作成APIと承認APIを分離し、作成者・承認者それぞれにfresh step-upを要求する。
- 会計調整の承認者は作成者と異なるactive staffでなければならない。
- `manual_acceptance` / `loss_accepted` / `goodwill` / `write_off` は理由と`evidence.evidence_ref`が必須で、`invoice.status`と`invoice.paid_tx_hash`を変更しない。

## Negative expectations
- `staff` は `review.update` / `audit.export` / `payments.control` / `staff.manage` / `terminal.manage` を持たない。
- 公開 invoice API は署名なしでは参照できない。
- session TTL 超過後の Bearer token は `401 UNAUTHORIZED` になる。

## Done when
- API middleware が permission で判定する。
- 二名承認違反がテストで検出される。
