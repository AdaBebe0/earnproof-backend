# Compatibility notes

Per [`docs/versioning.md`](versioning.md), every breaking change to a public
contract carries a note here: what changed, why, how a consumer migrates, and
who approved shipping it without the full staged deprecation process (minimum
support window, `Deprecation`/`Sunset` headers, usage measurement).

These entries document breaks shipped as a deliberate, one-shot exception to
the staged process, on the basis that this service has no external API
consumers outside this repository's own test suite and fixtures yet — the
work is pre-GA production-readiness hardening (see the originating issues),
not a change to a contract depended on in the wild. Approval for each entry is
requested through the normal PR review process on the PR that introduces it,
by a maintainer listed in `MAINTAINERS.md`.

## Issue #193 — webhook endpoint verification challenge workflow

```ts
{
  contractId: "POST /api/v1/webhooks",
  migration:
    "A newly created webhook endpoint now starts in `PENDING` status " +
    "instead of `ACTIVE`. No real event deliveries are sent until the " +
    "destination's ownership is verified (see POST /api/v1/webhooks/:id/verify). " +
    "A caller that previously assumed immediate delivery after creation must " +
    "now complete verification first.",
  supportWindowEndsAt: "shipped directly — no external consumers yet",
  approvedBy: "requested via PR review, see PR introducing this note",
}
```

New additive surface introduced alongside it (no note required, listed for
completeness): `PATCH /api/v1/webhooks/:id/url`, `POST
/api/v1/webhooks/:id/resend-verification`, `POST /api/v1/webhooks/:id/verify`.
