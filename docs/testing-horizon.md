# Testing against Horizon

Horizon is the one dependency this service cannot control and cannot do without.
It rate-limits, it times out, it pages, it occasionally hands back a cursor it
has already issued, and during a ledger reorganisation it replays records the
sync has already seen. Every one of those is ordinary operation, not an
incident — and every one of them is impossible to provoke on demand against a
real Horizon.

So the suite does not use one. Faults are **scripted**, from frozen fixtures,
through a transport seam. The client's decisions are the thing under test, and
decisions can only be tested when the inputs are chosen rather than observed.

```bash
npx jest src/stellar src/payments --runInBand
```

## What is under test

| Layer | File | Responsibility |
|---|---|---|
| Fault taxonomy | [`horizon-fault.ts`](../src/stellar/horizon-fault.ts) | Classify a failure; decide whether it is worth retrying |
| Transport seam | [`horizon-transport.ts`](../src/stellar/horizon-transport.ts) | One HTTP GET, with a deadline. No policy |
| Pagination client | [`horizon-client.ts`](../src/stellar/horizon-client.ts) | Walk cursors, retry, bound, deduplicate |
| Scripted transport | [`scripted-horizon-transport.ts`](../src/testing/horizon/scripted-horizon-transport.ts) | Serve fixtures deterministically |
| Fixtures | [`horizon-scenarios.json`](../test/fixtures/horizon/horizon-scenarios.json) | The scenarios themselves |

The seam exists so that everything above it is deterministic: given the same
sequence of responses, the client takes the same decisions every time.

## Fixture format

One versioned file: `test/fixtures/horizon/horizon-scenarios.json`.

```jsonc
{
  "fixtureVersion": 1,
  "horizonUrl": "https://horizon.synthetic.invalid",
  "account":     "GSYNTHETIC0RECEIVER0000…",   // the account being synced
  "counterparty":"GSYNTHETIC0SENDER0000…",     // the other side of each payment
  "assetIssuer": "GSYNTHETIC0ISSUER0000…",
  "epoch": "2026-01-01T00:00:00.000Z",         // records are hourly, newest first
  "scenarios": {
    "<scenario-id>": {
      "description": "why this scenario exists and what it must prove",
      "steps": [ /* one entry per HTTP request, in order */ ]
    }
  }
}
```

A **step** is what the transport returns for the *n*th request:

| Field | Meaning |
|---|---|
| `expectCursor` | The cursor the client must send. `null` means "no cursor". Omit to leave it unconstrained. |
| `response.status` | HTTP status to return. |
| `response.body` | Parsed JSON body, or `undefined` to simulate an unparseable one. |
| `response.headers` | Lowercased headers. Only `retry-after` is read. |
| `throw` | `"timeout"`, `"network"`, or `"abort"` — a transport-level failure instead of a response. |

`expectCursor` is the reason this is a fixture format rather than a pile of
mocks. It makes cursor correctness an assertion the *fixture* enforces: a client
that stops following `_links.next`, or sends the wrong cursor, fails inside the
transport with a message naming the mismatch, whatever the test happened to
assert.

The stub is strict elsewhere too. It refuses a request it has no step for, so a
client that pages further than the scenario intends cannot pass by accident — a
permissive stub returning an empty page for anything unexpected would hide
exactly the bug this suite exists to catch.

## No production data, by construction

The fixtures contain **no recorded production traffic**. Every value is derived
from a fixed seed:

| Value | Form | Why it cannot be real |
|---|---|---|
| Account addresses | `GSYNTHETIC0RECEIVER0000…` | Contains `0`, which is not in the base32 alphabet Stellar uses. No such address can exist. |
| Transaction hashes | `synthetic<hex>` | Cannot resolve in a block explorer. |
| Operation ids | `synthetic-op-000000` | Horizon ids are numeric; these are not. |
| Amounts | `100.0000000`, `101.0100000` | Derived from the record index. |
| Horizon origin | `horizon.synthetic.invalid` | RFC 2606 guarantees `.invalid` never resolves. |

Three tests in [`horizon-client.spec.ts`](../src/stellar/horizon-client.spec.ts)
enforce this, so it cannot regress: the file must contain no base32-shaped
address, no reference to a real Horizon host, and no transaction hash without
the `synthetic` marker.

This matters beyond privacy. A realistic-looking wallet address in a committed
fixture is indistinguishable from a leak of customer data, and nobody reviewing
it can tell by looking whether it needs to be handled as an incident.

## Scenarios

Twenty-seven, in seven groups.

**Empty and single page** — `empty-page`, `empty-embedded-absent`,
`single-page`. An absent `_embedded` is an empty feed, not corruption: Horizon
answers that way for an unused account, and failing there would make a new user
indistinguishable from an outage.

**Multi-page** — `multi-page`, `resume-from-cursor`, `endless-pages`,
`time-bounded`. Cursor walking, resumption, and each of the three bounds.

**Cursor pathologies** — `repeated-cursor`, `self-referential-cursor`,
`expired-cursor`, `gone-cursor`. A cursor that loops must terminate the walk; a
cursor Horizon rejects must not be retried.

**Reorganisation-like replay** — `overlapping-pages`, `fully-replayed-page`.
Page two repeats records from page one, as a lagging read replica or a ledger
reorganisation would. Deduplicated by operation id.

**Rate limits** — `rate-limited-then-ok`, `rate-limited-exhausted`,
`rate-limited-absurd-retry-after`. Including a 429 asking for an hour, which is
capped rather than honoured.

**Timeouts and server failures** — `timeout-then-ok`, `timeout-exhausted`,
`server-error-then-ok`, `server-error-mid-walk`, `network-error-then-ok`,
`fails-on-second-page`.

**Permanently invalid input** — `malformed-page-body`, `unparseable-body`,
`account-not-found`, `malformed-records`, `non-payment-records`.

## The retry decision

This is the part worth getting right, because both directions of error are
expensive: retrying a permanent fault burns the budget and delays the real
error, while giving up on a transient one drops payments that the next attempt
would have delivered.

| Condition | Kind | Retried |
|---|---|---|
| HTTP 429 | `rate_limited` | **Yes** — honouring `Retry-After`, capped at 60s |
| HTTP 5xx | `server_error` | **Yes** — exponential backoff |
| Deadline exceeded | `timeout` | **Yes** |
| Connection failed | `network_error` | **Yes** |
| HTTP 400 / 410 | `expired_cursor` | No |
| HTTP 404 | `not_found` | No |
| Other 4xx | `client_error` | No |
| 2xx, body is not a collection | `malformed_page` | No |
| A single unusable record | *skipped, counted* | No |

Two of these are worth spelling out.

**`expired_cursor` is not retryable, but it is recoverable.** Repeating the
request cannot work; the caller has to drop the cursor and restart. That is a
different decision from "wait and try again", which is why it is not in the
retryable set.

**A malformed record does not fail its page.** It is counted in
`malformedRecords` and skipped. A page mixing six unusable records with two good
ones yields two payments — dropping the page would lose real money movements
because of unrelated corruption, and retrying it would loop forever on records
that can never become valid.

The retry budget is **per page**, so a read that survives a rate limit on page
one still has its full allowance for page two.

## Bounds

Horizon will page forever. Every loop is explicitly bounded, and the result says
which bound stopped it via `stopReason`:

| Bound | Default | `stopReason` |
|---|---|---|
| Pages per read | 10 | `page_bound` |
| Records per read | 2000 | `record_bound` |
| Oldest record of interest | none | `time_bound` |
| Cursor already seen | — | `repeated_cursor` |
| Feed ended | — | `exhausted` |

Pages are walked newest-first (`order=desc`), which is what makes the time bound
sound: once a page's oldest record precedes the boundary, no later page can
contain anything in range.

`lastCursor` is returned whenever a bound stopped the walk, so the caller can
continue from where it left off rather than starting over.

## Cursors are rebuilt, never followed

Horizon supplies `_links.next.href` as an absolute URL. The client extracts only
the `cursor` parameter and rebuilds the request against the configured Horizon
origin.

Following the href directly would let a compromised or misconfigured upstream
point the sync at a host of its choosing — a request-forgery primitive handed
over for free, on a code path that runs with the service's own network access.
A test asserts every request went to the configured origin.

## Determinism

Nothing in this suite reads the clock, a random source, or the network.

- **Backoff is recorded, not slept.** `RecordingSleep` captures the delays the
  client asked for and returns immediately. The retry policy is asserted as a
  sequence of decisions — `[200, 400]`, or `[2000]` when `Retry-After` said so —
  rather than waited out. This is why the suite is instant and why it is not the
  flaky one people learn to re-run.
- **Cancellation is driven from the transport.** `abortAfterRequests` aborts the
  caller's signal once *n* requests have been served, so "cancelled mid-walk" is
  reproducible without a timer.
- **Timestamps come from a fixed epoch.** Records are hourly offsets from
  `2026-01-01T00:00:00.000Z`, so a fixture generated today and one generated
  next year are byte-identical.

If you find yourself adding a `setTimeout`, a `Date.now()`, or a retry loop to a
test in this suite, something is wrong with the seam rather than with the test.

## Updating fixtures

The fixtures are **frozen**. They are generated once from a fixed seed and
committed; there is deliberately no regeneration script in the repository,
because a regeneration script is an invitation to silently rewrite a fixture to
make a failing test pass.

When a fixture change is genuinely needed:

1. **Establish which way the disagreement runs.** A failing scenario means the
   client's behaviour and the fixture's expectation differ. Decide whether the
   client regressed or the scenario was wrong *before* touching either.
2. **Prefer adding a scenario to editing one.** An existing scenario is a
   recorded decision about how the client must behave. Adding
   `rate-limited-with-no-retry-after` costs nothing; editing
   `rate-limited-then-ok` silently changes what the suite guarantees.
3. **Edit `horizon-scenarios.json` directly** for a new scenario. It is plain
   JSON: add a key under `scenarios` with a `description` explaining what the
   scenario must prove, and the `steps` array.
4. **Keep every value synthetic.** Addresses must contain a character outside
   base32 (`0`, `1`, `8`, `9`). Hashes must carry the `synthetic` marker.
   Never paste a real Horizon response, even a testnet one — testnet addresses
   look exactly like mainnet addresses to a reviewer.
5. **Bump `fixtureVersion` if the *shape* changes** — a new step field, a
   renamed key, a different scenario structure. The loader refuses a version it
   does not recognise, so a shape change fails once, loudly, instead of once per
   scenario in a way that looks unrelated. Update `SUPPORTED_FIXTURE_VERSION` in
   [`scripted-horizon-transport.ts`](../src/testing/horizon/scripted-horizon-transport.ts)
   in the same change.
6. **Adding a scenario does not need a version bump.** New keys under
   `scenarios` are additive.

### Recording from a real Horizon

Don't. If a future scenario genuinely requires a response shape nobody can write
by hand, capture it from **testnet only**, and before committing it: replace
every address, transaction hash, and operation id with synthetic equivalents,
strip `_links` hosts, and confirm the three fixture-hygiene tests still pass.
The result is a synthetic fixture that happens to have been informed by a real
shape — which is the only form of "recorded" fixture this repository accepts.

## Related

- [Architecture](architecture.md) — where `stellar` sits and what it may depend on.
- [Test data and factories](test-data.md) — the same synthetic-by-construction
  rule, applied to database fixtures.
- [Integration testing](integration-testing.md) — the PostgreSQL harness, which
  covers payment uniqueness at the database level.
