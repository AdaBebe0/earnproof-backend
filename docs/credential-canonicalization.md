# Credential canonicalization and signing

Credential signing is owned by `ProofsService.signCredential`; verification is
owned by `CredentialsService.verifyCredential`. The algorithm is HMAC-SHA256
over the canonical JSON body (the credential excluding `proof`), keyed with the
raw UTF-8 bytes of `CREDENTIAL_SIGNING_SECRET`.

`test/fixtures/credentials/canonicalization-vectors.json` is the published,
synthetic cross-runtime contract. It records canonical JSON, its UTF-8 bytes,
SHA-256 credential hash, signing base, and signature. The independent verifier
in `scripts/credential-verifier/` intentionally does not import backend code.

Rules: object keys sort lexicographically at every depth; array order is kept;
`null` is kept; omitted properties are omitted; strings are byte-exact UTF-8 and
are not Unicode-normalized; finite JSON numbers use ECMAScript JSON rendering.
`NaN`, `Infinity`, and `-Infinity` are rejected with
`UnsupportedCanonicalNumberError`, never coerced to `null`.

The schema version belongs to the credential contract, independently of the
REST API. Do not alter canonicalization or an existing schema version: doing so
invalidates issued credentials. Add a new credential schema version and retain
verification support for the old version throughout the 365-day compatibility
window in `docs/versioning.md`.
