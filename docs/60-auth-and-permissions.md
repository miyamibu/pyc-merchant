# 60. Auth and Permissions

## Goal
`staff/manager/admin` を操作別権限へ展開し、重要操作を分離する。

## Session
- 端末ログイン: `terminalCode + staffPin`
- TTL失効: `SESSION_TTL_SEC`
- 強制失効: `/api/v1/terminal-sessions/:id/revoke`
- セッションは Bearer token のみで扱い、cookie session を前提にしない。

## Permission Model
- `invoice.create`, `invoice.read`
- `review.read`, `review.update`
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

## Negative expectations
- `staff` は `review.update` / `audit.export` / `payments.control` / `staff.manage` / `terminal.manage` を持たない。
- 公開 invoice API は署名なしでは参照できない。
- session TTL 超過後の Bearer token は `401 UNAUTHORIZED` になる。

## Done when
- API middleware が permission で判定する。
- 二名承認違反がテストで検出される。
