# Data And State Invariants

- Business records must not be hard-deleted.
- Settlement exports must preserve export_reference traceability.
- Canonical payment/refund/audit evidence must not be replaced by terminal-local or adapter output.
- External evidence must remain pending unless verified from concrete artifacts.
- Non-custodial operation must not store private keys, seed phrases, mnemonics, keystores, or signing authority.
