# EXT-003 Public FQDN TLS

- status: pending
- domain:
- tls_issuer:
- tls_expiry:
- healthz_result:
- readyz_result:
- pay_ref_result:
- https_redirect_result:
- screenshot_ref:
- tester:
- checked_at:
- run_command: `bash scripts/deploy/healthcheck.sh https://<public-host>/healthz`

## Goal
公開FQDN/TLS/HTTPS導線の本番条件を確認する。

## Constraints
placeholder domain を入れない。

## Done when
status=pass かつ required fields が埋まっている。
