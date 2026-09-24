# Runbook: Verification outcome shift

## What fired

| Alert | Condition | Severity | Owner |
|---|---|---|---|
| Verification shift | `invalid` share of `verifications_total` doubles week-on-week | **P3** | Product engineering |

The mix of verification results changed. This is **not** an availability alert
and does not page. The service is answering verification requests correctly; what
changed is the distribution of answers.

**Why P3.** Every plausible cause — an attack, a client bug, a regression, or a
genuine change in usage — needs investigation rather than interruption. Paging on
it would train responders to ignore it.

**Why a relative threshold.** The absolute rate depends on integration mix and
drifts as customers onboard. A week-on-week ratio detects change without needing
a hand-tuned baseline per tenant.

## Diagnose

This is the alert where the temptation to reach for per-proof data is strongest.
Resist it: work through the aggregate first, and only query records if the
aggregate genuinely cannot answer the question.

### 1. Which outcome moved?

```
sum by (verification_outcome) (rate(verifications_total[1h]))
```

Each shift means something different:

- **`invalid` up** → signature or payload problems. A client bug, a regression,
  or probing.
- **`expired` up** → normal if a cohort of proofs aged out together. Check
  issuance timing before treating it as a fault.
- **`revoked` up** → often legitimate. Confirm whether a revocation campaign ran.
- **`not_found` up** → callers referencing proofs that do not exist. Either
  fabricated IDs, or a data problem on our side.

### 2. Gradual or a step change?

A step change points at a deployment — ours or a large integrator's. A gradual
drift is more likely a changing usage mix.

### 3. Did we deploy?

Correlate onset with the release timeline. Changes to credential signing,
verification logic, or hashing all show up here first.

### 4. Is volume also up?

```
sum(rate(verifications_total[1h]))
```

A rise in `invalid` *and* total volume suggests probing. A rise in `invalid`
share at flat volume suggests something broke for existing callers.

### 5. Concentrated or spread?

The metric carries no tenant dimension by design. Determine concentration from
logs over the window. One integrator points at their client; many points at us.

> If the diagnosis genuinely needs record detail, query the database directly.
> Do not paste proof IDs, credential hashes, or wallet addresses into a ticket.

## Mitigate

| Cause | Action |
|---|---|
| Our regression in verification or signing | Roll back. Existing credentials may verify incorrectly until fixed. |
| One integrator's client bug | Contact them. No change needed on our side. |
| Probing or enumeration | Assess rate limits. Confirm no information is leaked by the difference between `invalid` and `not_found`. |
| Cohort expiry | No action. Confirm the issuance dates explain it. |
| Revocation campaign | No action. Record it so the next responder is not surprised. |

## Verify

- Distribution back near its prior baseline, or the shift explained and
  documented.
- If a regression: the rolled-back version restores the previous mix.
- If an integrator: they confirm the fix and their share returns to baseline.

## Escalate

- A verification-logic regression reached production — previously valid
  credentials may have been rejected, which is a customer-trust issue.
- The pattern looks like a deliberate attack rather than a bug.
- Verification results appear incorrect rather than merely differently
  distributed, which is a correctness incident, not an observability one.
