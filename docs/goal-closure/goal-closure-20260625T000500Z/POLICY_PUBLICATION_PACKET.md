# Policy Publication Packet

## Goal

Prepare the local handoff for terms, privacy, and refund policy publication without falsely marking draft policy text as approved or public.

## Context

`public/mobile.js` currently has empty `POLICY_URLS`. The commercial validator correctly blocks customer policy URL readiness until all three URLs are public HTTPS URLs.

Existing local drafts:

- `docs/legal/terms-draft.md`
- `docs/legal/privacy-policy-draft.md`
- `docs/legal/refund-policy-draft.md`
- `docs/legal/customer-consent-requirements.md`

## Constraints

- Do not write draft or local URLs into `public/mobile.js`.
- Do not mark legal review complete without an approval reference.
- Do not publish or deploy from this local packet.
- Do not use `pay.miyamibu.xyz` until DNS/TLS resolves and serves the approved policy content.

## Done When

The human owner provides:

| Item | Required value |
|---|---|
| Terms URL | Public HTTPS URL returning approved terms text |
| Privacy URL | Public HTTPS URL returning approved privacy text |
| Refund URL | Public HTTPS URL returning approved refund policy text |
| Legal approval ref | `LEGAL-YYYY-MMDD-NNN` or equivalent signed ref |
| Privacy approval ref | `PRIV-YYYY-MMDD-NNN` or equivalent signed ref |
| APPI approval ref | `APPI-YYYY-MMDD-NNN` plus retention/deletion/disclosure procedure refs |
| Content hashes | SHA-256 hash for each published policy document |

## Validation Method

```bash
curl -I https://<public-host>/terms
curl -I https://<public-host>/privacy
curl -I https://<public-host>/refund
npm run check
npm test
npm run commercial:validate
```

## Failure Handling

If any URL is not public HTTPS, returns non-200, has draft text, lacks approval ref, or has a changed content hash after approval, keep `POLICY_URLS` empty and keep the release `NO_GO`.
