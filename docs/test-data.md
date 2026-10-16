# Test Data and Demo Factories

Contributors were repeatedly hand-building users, organizations, payments,
proofs, issuers, and delivery records. That is slow, and it carries a real
hazard: hand-written fixtures tend to look realistic, and a realistic-looking
wallet address or transaction hash pasted into an issue is indistinguishable
from a leak of real customer data. Nobody reviewing it can tell whether it needs
to be treated as an incident.

These factories produce data that is **deterministic** and **unmistakably
synthetic**.

## Quick start

```ts
import {
  buildUser,
  buildProof,
  expiredProof,
  revokedProof,
  unanchoredProof,
} from "../testing/factories";

const user = buildUser("alice");
const proof = buildProof("p1", user.id);

// Awkward states get named builders, because these are the ones hand-written
// fixtures usually model wrongly.
const expired = expiredProof("p2", user.id);
const revoked = revokedProof("p3", user.id);
const unanchored = unanchoredProof("p4", user.id);
```

A full relationally-valid scenario:

```ts
import { buildDemoScenario } from "../testing/factories/scenario";

const scenario = buildDemoScenario("my-test");
// scenario.users, .organizations, .issuers, .payments, .proofs,
// .apiKeys, .webhooks, .deliveries, .anchoringIntents
```

## Intent-based builders

Builders are named for the **scenario** they express, not the Prisma shape they
produce.

This is the difference between:

```ts
// Brittle: asserts on columns the test does not care about, so a harmless
// schema addition breaks it.
const proof = { id: "...", userId: "...", proofType: "MINIMUM_INCOME", /* 12 more */ };

// Intent-based: states only what matters.
const proof = revokedProof("seed", user.id);
```

Every builder takes `(seed, ...relations, overrides?)` and returns a plain
object. Overrides are shallow-merged, so a test states only the field it cares
about and inherits sane values for the rest.

### Covered states

| Resource | States |
|---|---|
| User | active, suspended, role variants |
| Organization | active, pending |
| Issuer | active, suspended, revoked |
| Payment | income, excluded, unclassified |
| Proof | active, expired, revoked, invalid, **unanchored** |
| API key | active, expired, revoked |
| Webhook delivery | success, pending, failed |
| Anchoring intent | confirmed, pending, failed |

`unanchoredProof` is called out because `contractTransactionHash: null` is easy
to forget by hand and is exactly the state that distinguishes "recorded locally"
from "committed on-chain".

## Determinism

Nothing reads the clock or a random source. Values derive from a SHA-256 digest
of `(namespace, seed)`, which acts purely as a deterministic spreading function —
no security property is claimed.

Timestamps are offsets from a fixed `SYNTHETIC_EPOCH` (2025-01-01), not
`Date.now()`. A fixture generated today and one generated next month are
byte-identical, so snapshot comparisons do not drift daily.

Because generation is a pure function of the seed, any field can be generated
independently, in any order, without threading generator state through builders.

## Privacy constraints

Every generated value is recognisable as fake **on sight**. This is the actual
privacy control, and it is why each rule exists:

| Value | Form | Why |
|---|---|---|
| Wallet address | `GSYNTHETIC…` | Not valid base32+CRC, so it can never address a real account |
| Transaction hash | `synthetic…` | Cannot resolve in a block explorer |
| Credential hash | `sha256:synthetic…` | Distinguishable from a real digest |
| Secret | `synthetic-not-a-real-secret-…` | Classified instantly by a secret scanner or a human reviewer |
| URL | `*.example.invalid` | RFC 2606 guarantees it never resolves, so a seeded webhook cannot deliver anywhere real |
| Amount | decimal **string** | Money through binary floats accumulates rounding error |

The literal token `SYNTHETIC` is embedded deliberately so it is greppable: finding
it in a production database or log is an immediate, unambiguous signal that test
data reached somewhere it should not have.

### Amounts are strings

`syntheticAmount()` returns `"1234.56"`, not `1234.56`. Binary floating point
cannot represent most decimal amounts exactly, and a factory that introduced
rounding error would make tests assert on subtly wrong values.

### Encrypted columns are not bypassed

`buildPayment()` exposes a plaintext `amount` **for assertions only**. The seed
script never writes it, because the schema stores `amountEncrypted`. A factory
that wrote plaintext into an encrypted column would quietly train contributors to
write fixtures that violate the application's own privacy boundary.

## Demo seed

```bash
npm run seed:demo
```

This is **separate from `prisma/seed.ts`** on purpose. That file seeds reference
data (supported assets) that every environment legitimately needs. This one
writes fabricated users, payments, and proofs, which only a local or disposable
environment should ever contain — so no routine `prisma db seed` can pull demo
records in by accident.

### Production refusal

The seed refuses to run against anything that is not clearly disposable, and
fails closed on every uncertain input:

1. `NODE_ENV=production` → refuse. **Cannot be overridden.**
2. `DATABASE_URL` unset or unparseable → refuse. An unknown target is not a safe
   target.
3. Host not in the local allow-list (`localhost`, `127.0.0.1`, `::1`,
   `host.docker.internal`, `postgres`, `db`) → refuse unless
   `ALLOW_SYNTHETIC_SEED=true`.

The override exists for CI containers and review environments, whose hostnames
are not `localhost`. It deliberately cannot bypass rule 1.

The check runs **before** a Prisma client is constructed — refusing after opening
a connection to production would already be later than anyone wants. Refusal
messages never echo the database password, because they land in CI logs which are
far more widely readable than the environment that produced them.

### Idempotency

Every write is an `upsert` keyed on a deterministic synthetic id, so re-running
converges instead of accumulating duplicates. This depends on stable IDs: with
random IDs each reseed would insert a fresh set of rows rather than updating in
place.

### Cleanup

Every seeded id is prefixed `synthetic_`, so removal is a prefix match:

```sql
DELETE FROM "WebhookDelivery" WHERE id LIKE 'synthetic\_%';
DELETE FROM "Webhook"         WHERE id LIKE 'synthetic\_%';
DELETE FROM "Proof"           WHERE id LIKE 'synthetic\_%';
DELETE FROM "Payment"         WHERE id LIKE 'synthetic\_%';
DELETE FROM "Issuer"          WHERE id LIKE 'synthetic\_%';
DELETE FROM "Organization"    WHERE id LIKE 'synthetic\_%';
DELETE FROM "User"            WHERE id LIKE 'synthetic\_%';
```

Delete in that order — it is the reverse of the foreign-key graph.

## Extending

Add a builder when a state is awkward to construct by hand or easy to get wrong.

1. Put value generation in `synthetic.ts` — it must be deterministic and carry a
   synthetic marker.
2. Put the builder in `index.ts`, named for the scenario, taking
   `(seed, ...relations, overrides?)`.
3. If it belongs in the demo scenario, add it to `scenario.ts` and to
   `applyDemoScenario` in
   [`src/testing/seed/apply-demo-scenario.ts`](../src/testing/seed/apply-demo-scenario.ts),
   whose insertion order follows the foreign-key graph.
4. Add coverage to `factories.spec.ts`. At minimum, assert determinism and that
   generated identifiers are synthetic.

Do **not** add a builder that reads the clock, a random source, or the database:
each of those breaks determinism, and determinism is what makes these fixtures
safe to compare and safe to reseed.

## Testing

```bash
npx jest src/testing --runInBand
```

Coverage includes determinism (including under a mocked system clock),
referential integrity across the whole scenario, uniqueness of every unique
column, production refusal in all its forms, and idempotent reseeding.

Running the seed and reset commands themselves — and the guards that stand in
front of them — is documented in
[development database tooling](development.md).
