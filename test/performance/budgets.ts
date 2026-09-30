/**
 * Named performance budgets for critical queries.
 *
 * Every budget below is a ceiling, not a target: the "baseline" comment
 * records what the query actually measured at the fixture scale defined in
 * `harness/scale-seed.ts` (`DEFAULT_SCALE`) when the budget was written, and
 * the budget itself is the baseline plus headroom for CI variance (a shared
 * runner's disk and CPU contention, a colder page cache) — not for query
 * regressions. A query that already needs the full headroom to pass is a
 * signal to investigate, not to raise the budget further.
 *
 * ## Changing a budget
 *
 * A budget number must not move without evidence attached to the PR that
 * changes it:
 *
 * 1. Run `npm run test:performance` locally (or paste CI's output) and
 *    include the new observed `executionTimeMs` / plan-cost figures in the
 *    PR description.
 * 2. State the reason the query legitimately got slower or faster — a new
 *    column in the `SELECT`, an intentional index drop, a fixture scale
 *    change — not just "the test was flaky."
 * 3. Get the change reviewed by someone other than the author. A budget is a
 *    regression gate; relaxing it without review defeats the reason this
 *    suite exists.
 * 4. Update the baseline comment next to the constant in the same PR, so the
 *    next reader sees *why* the number is what it is instead of just what it
 *    is now.
 *
 * Budgets are intentionally generous multiples of the observed baseline
 * (rather than tight percentages) because CI hardware is not the machine the
 * baseline was measured on. The suite is a regression tripwire for
 * order-of-magnitude problems — a missing index, a scan that stopped being
 * bounded — not a micro-benchmark.
 */

export interface QueryBudget {
  /** Human-readable name, also used as the test description. */
  name: string;
  /** Maximum wall-clock execution time (EXPLAIN ANALYZE's "Execution Time"), in ms. */
  maxExecutionTimeMs: number;
  /** Maximum planner total-cost estimate for the query's root node. */
  maxTotalCost: number;
  /** Provenance: what was observed when this budget was set, and why the ceiling is where it is. */
  provenance: string;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * `SessionService#validate` — `AuthSession.findUnique({ where: { tokenHash } })`.
 *
 * Every authenticated request runs this. `tokenHash` is `@unique`, so
 * PostgreSQL should always resolve it with an index (or index-only) scan
 * regardless of table size.
 */
export const AUTH_SESSION_VALIDATE_BUDGET: QueryBudget = {
  name: "auth: session token lookup (AuthSession.tokenHash unique index)",
  // Baseline observed against ~8,010 seeded sessions (DEFAULT_SCALE):
  // an index scan on the unique tokenHash index, sub-millisecond.
  // Ceiling set generously above that because this query runs on the hot
  // path of every authenticated request.
  maxExecutionTimeMs: 25,
  maxTotalCost: 20,
  provenance:
    "Baseline: <1ms index scan against 8,010 seeded AuthSession rows " +
    "(unique index on tokenHash). Budget is a wide multiple because a " +
    "regression here (e.g. the unique constraint dropped, or a filter added " +
    "that defeats the index) degrades every authenticated request, not just " +
    "one endpoint.",
};

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * `PaymentsService#listPayments` — filtered, paginated payment history.
 * `findMany({ where: { userId, classification?, assetCode? }, orderBy: { occurredAt: "desc" }, take: 100 })`
 *
 * Matches `Payment.@@index([userId, occurredAt])`.
 */
export const PAYMENT_LIST_BUDGET: QueryBudget = {
  name: "payment: listPayments (Payment[userId, occurredAt] composite index)",
  // Baseline observed against a heavy user with 6,000 payments (out of
  // ~184,000 total seeded rows): index scan on (userId, occurredAt), plan
  // cost in the low hundreds because it still has to sort/limit within the
  // matched partition.
  maxExecutionTimeMs: 60,
  maxTotalCost: 500,
  provenance:
    "Baseline observed against a heavy user with 6,000 payments (184,000 " +
    "total rows across 4,005 users): index scan via the (userId, occurredAt) " +
    "composite index, ~5-15ms locally. Budget leaves headroom for CI " +
    "variance while still catching the case where this degrades to a " +
    "sequential scan of the whole Payment table.",
};

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

/**
 * `ProofsService#listProofs` — cursor-paginated proof history, deep page.
 * `findMany({ where: { userId, ... }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21, cursor, skip: 1 })`
 *
 * Matches `Proof.@@index([userId, createdAt, id])`. Exercised at a deep
 * cursor position (not page 1) because a plan that looks fine on the first
 * page can still degrade at depth if the cursor comparison does not use the
 * index.
 */
export const PROOF_LIST_DEEP_PAGE_BUDGET: QueryBudget = {
  name: "proof: listProofs deep cursor page (Proof[userId, createdAt, id] composite index)",
  // Baseline observed against a heavy user with 1,200 proofs, cursor
  // positioned ~40 pages in (page size 20).
  maxExecutionTimeMs: 40,
  maxTotalCost: 200,
  provenance:
    "Baseline observed against a heavy user with 1,200 proofs (60,025 total " +
    "rows across 4,005 users), cursor positioned at page ~40 of 20-row " +
    "pages: index scan via (userId, createdAt, id), ~2-8ms locally. Cursor " +
    "pagination should not degrade with page depth the way OFFSET would; " +
    "the budget mainly guards against someone swapping this back to offset " +
    "pagination or losing the composite index.",
};

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

/**
 * `CredentialsService#verifyCredential` — `Proof.findUnique({ where: { credentialHash } })`.
 *
 * `credentialHash` is `@unique`. This is the public, unauthenticated
 * verification endpoint (see docs/adr/0004), so it is the query most exposed
 * to being hammered by an external caller.
 */
export const CREDENTIAL_VERIFY_LOOKUP_BUDGET: QueryBudget = {
  name: "credential: verifyCredential lookup (Proof.credentialHash unique index)",
  // Baseline observed against ~60,025 seeded proofs: index scan on the
  // unique credentialHash index, sub-millisecond.
  maxExecutionTimeMs: 25,
  maxTotalCost: 20,
  provenance:
    "Baseline: <1ms index scan against 60,025 seeded Proof rows (unique " +
    "index on credentialHash). This endpoint is public and unauthenticated " +
    "(ADR 0004), so a regression here is directly exploitable as a " +
    "denial-of-service surface, not just a slow page.",
};

// ---------------------------------------------------------------------------
// Job / scheduled task
// ---------------------------------------------------------------------------

/**
 * `WebhookDeliveryService#onModuleInit` retry sweep —
 * `WebhookDelivery.findMany({ where: { status: PENDING }, orderBy: { createdAt: "asc" } })`.
 *
 * Matches `WebhookDelivery.@@index([status, nextRetryAt])`. Runs at process
 * startup and (structurally identical query shape) is the same filter the
 * scheduled retry path re-checks, so an unbounded scan here would repeat on
 * every restart and every retry tick.
 */
export const WEBHOOK_RETRY_SWEEP_BUDGET: QueryBudget = {
  name: "job: webhook retry sweep (WebhookDelivery[status, nextRetryAt] composite index)",
  // Baseline observed against 5,000 PENDING deliveries out of 5,000 total
  // seeded delivery rows (all pending, worst case for this filter).
  maxExecutionTimeMs: 80,
  maxTotalCost: 700,
  provenance:
    "Baseline observed against 5,000 seeded WebhookDelivery rows, all " +
    "PENDING (worst case: the filter matches every row): index scan via " +
    "the (status, nextRetryAt) composite index, ~5-20ms locally. Budget is " +
    "wider than the lookup-style budgets above because this query " +
    "legitimately returns a large result set by design; it guards against " +
    "the index scan degrading to a full sequential scan, not against the " +
    "row count itself.",
};

/**
 * `CleanupJob#cleanupChallenges` phase 1 — expired-challenge sweep.
 * `WalletChallenge.deleteMany({ where: { expiresAt: { lt: now } } })`.
 *
 * Matches `WalletChallenge.@@index([expiresAt])`. Runs daily
 * (`AUTH_CHALLENGE_CLEANUP_CRON`, default `EVERY_DAY_AT_2AM`).
 */
export const WALLET_CHALLENGE_EXPIRY_SWEEP_BUDGET: QueryBudget = {
  name: "job: wallet challenge expiry sweep (WalletChallenge[expiresAt] index)",
  // Baseline observed against 10,000 seeded challenges, ~1/3 expired.
  maxExecutionTimeMs: 60,
  maxTotalCost: 400,
  provenance:
    "Baseline observed against 10,000 seeded WalletChallenge rows (~3,334 " +
    "expired): index scan via the expiresAt index, ~3-12ms locally. Runs " +
    "unattended on a daily cron; a regression to a sequential scan would go " +
    "unnoticed until the challenges table grew large enough to show up as a " +
    "slow-query alert in production.",
};
