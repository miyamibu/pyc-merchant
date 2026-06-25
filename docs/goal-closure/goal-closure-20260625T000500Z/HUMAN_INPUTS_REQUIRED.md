
# Human Inputs Required

Release ID: `goal-closure-20260625T000500Z`

## Required before any GO-class release decision

- Select exactly one target release profile: `commercial` or `limited`.
- Provide signed legal approval reference.
- Provide signed AML approval reference.
- Provide signed privacy approval reference.
- Provide signed APPI approval reference.
- Provide official JPYC token contract approval reference and RPC verification evidence.
- Provide confirmation policy approval reference.
- Provide backscan policy approval reference.
- Provide production-safe secrets/configuration through the approved secret channel, not chat or logs.
- Provide public HTTPS policy URLs with approved content hash.
- Provide explicit release manifest bound to this release fingerprint.
- Provide real EXT evidence: EXT-001, EXT-002, EXT-003, EXT-004.
- Provide paid PoC KPI evidence: POC-001, POC-002, POC-003.
- Provide release owner signed decision after all machine gates pass.

## Stop condition

Until these inputs are present and validators pass, the correct state is `NO_GO` / fail-closed.
