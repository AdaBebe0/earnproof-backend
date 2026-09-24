# ADR-0006: Outbox pattern for contract anchoring

- **Status:** accepted
- **Date:** 2026-08-26

## Context

Issuing a proof writes to the database and anchors a commitment on Soroban.
These cannot be atomic: one is a database transaction, the other a ledger
submission that may take seconds, fail transiently, or succeed after the caller
gives up.

Submitting inline would tie issuance latency to the ledger and leave the
system inconsistent whenever submission failed after the database committed.

## Decision

Issuance writes an `AnchoringIntent` row inside the same transaction as the
proof and its claim
([`proofs.service.ts:214`](../../src/proofs/proofs.service.ts#L214)). A
background worker
([`anchoring-worker.service.ts`](../../src/jobs/anchoring-worker.service.ts))
claims pending intents in bounded batches, submits, and records the result.

A separate reconciler
([`anchoring-reconciler.service.ts`](../../src/jobs/anchoring-reconciler.service.ts))
resets intents left in `PROCESSING` by a crashed worker.

`@@unique([proofId, operation])` prevents duplicate intents for the same
operation.

## Consequences

**Easier.** Issuance returns immediately; ledger latency is off the request
path. A crash after commit loses nothing — the intent is durable and gets
retried. Retries are bounded with exponential backoff, so a permanently failing
intent stops rather than spinning.

**Harder.** Anchoring is eventually consistent: a proof exists and is verifiable
before it is anchored, and consumers must not assume otherwise. Two components
must be running, not one — a deployment with the worker but no reconciler
accumulates stuck intents silently, which is why
[`../architecture.md`](../architecture.md) records both. Permanently failed
intents need an operator to requeue them.

**Ruled out.** Treating "proof issued" as "proof anchored". They are distinct
states and the API surfaces them separately.

## Alternatives considered

**Submit inline during issuance.** Rejected: it couples issuance latency to the
ledger and leaves no recovery path when submission fails after commit.

**External queue such as Redis or SQS.** Viable, and better at high volume.
Rejected for now because a database table gives transactional enqueue for free —
the intent commits with the proof, which an external queue cannot guarantee
without a distributed transaction.
