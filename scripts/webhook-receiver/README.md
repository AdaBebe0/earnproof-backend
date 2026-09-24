# Webhook conformance kit

Reference implementation and conformance runner for EarnProof's signed webhooks.

The security guide — raw-body preservation, constant-time comparison, timestamp
tolerance, deduplication, retries, secret rotation — is
[`docs/webhooks.md`](../../docs/webhooks.md). This file covers only how to run
what is here.

| File | What it is |
|---|---|
| `verifier.ts` | The reference verifier. Dependency-free, meant to be read and ported. |
| `receiver.ts` | A runnable HTTP receiver built on the verifier. |
| `conformance.ts` | Runs every golden vector through both, in-process and over a socket. |

## Run the conformance suite

```bash
npm run webhook:conformance
```

Exits non-zero on the first failing check, printing the check name and what it
expected. Runs in CI on every pull request.

It executes each vector twice: once against the verifier directly, and once
through a real HTTP server on `127.0.0.1`. The second pass is the one that
catches a framework quietly re-serialising the body — the failure mode that
in-process tests cannot see.

## Run the receiver on its own

```bash
EARNPROOF_WEBHOOK_SECRET=<your-endpoint-secret> npm run webhook:receiver
```

Binds to `127.0.0.1` on an ephemeral port; set `PORT` to pin one. Accepts
`--secret <value>` as well, but prefer the environment variable — command-line
arguments are readable by every local user in the process list.

Pass `--secret` more than once, or combine it with the environment variable, to
hold several secrets during a rotation window.

Responses: `204` accepted, `200` duplicate, `400` malformed or stale, `401`
signature mismatch, `413` body too large.

## The vectors

[`test/fixtures/webhooks/signing-vectors.json`](../../test/fixtures/webhooks/signing-vectors.json)
is language-neutral and has no dependency on this repository — an implementation
in any language can be checked against it.

The vectors are **frozen**. They are the wire contract, so a mismatch means the
protocol changed and every integrator breaks at once. If a change to the signer
makes them fail, the question is whether the wire format changed, not whether the
file needs updating. There is deliberately no regeneration script.

Every secret in the file is synthetic and grants nothing.
