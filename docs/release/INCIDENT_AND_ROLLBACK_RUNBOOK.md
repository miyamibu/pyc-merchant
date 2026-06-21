# Incident And Rollback Runbook

Initial release posture: keep PAYMENTS_DISABLED=true until signed manifest, readyz 200, external evidence, and two-person approval are verified.

Rollback: keep existing inquiries/review read-only available, disable new invoice issuance, preserve audit evidence, and do not delete business records.
