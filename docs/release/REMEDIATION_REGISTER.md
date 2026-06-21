# Remediation Register

## Open P0
- external legal/AML/privacy/APPI approvals are missing
- real JPYC payment evidence EXT-001 is missing
- wallet/device evidence EXT-002 is missing
- public TLS evidence EXT-003 is pending/incomplete
- store operations drill EXT-004 is missing
- release manifest is not signed by independent approvers
- Node runtime is not aligned with required Node 24 LTS exact image
- server-start tests fail because better-sqlite3 was built for a different Node ABI
- production validation did not complete because full test run hung

## Open P1
- EXT-005..EXT-015 are not implemented or not evidenced in the current repository
- Docker image digest, SBOM, provenance, signature, and image scan are not attached
- real backup/restore, disk-full, power/network fault drills are not evidenced
- real RPC failover/reorg simulation is not evidenced
- actual iPad/Android/iPhone accessibility and wallet launch videos are not evidenced
- some SSE/log redaction/rate-limit hardening concerns remain from analyst review
