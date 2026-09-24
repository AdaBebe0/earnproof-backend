# Graceful Shutdown

How this service drains in-flight work before exiting, and how to verify it.
See also [`docs/health-checks.md`](./health-checks.md) — shutdown reuses the
readiness probe rather than inventing a second signal.

## Sequence

`SIGTERM` (or `SIGINT`) triggers, in order:

1. **Readiness flips to `not_ready` first.** `main.ts`'s signal handler calls
   `HealthService.beginShutdown()` before anything else. `GET /health/ready`
   answers `not_ready` from that instant, without even probing the database —
   see `HealthService.checkReadiness`. A load balancer that polls readiness
   stops routing new traffic here as early in the sequence as possible.
2. **`app.close()` runs Nest's module-destroy sequence.** This requires
   `app.enableShutdownHooks()`, called once in `main.ts` — without it, Nest
   never invokes `onModuleDestroy`/`onApplicationShutdown` on `SIGTERM` at
   all, and the process would exit mid-work with no warning.
3. **Each worker with in-flight work drains itself**, bounded by its own
   timeout (below), then the process exits `0`. A shutdown that does not
   complete cleanly (an unexpected exception from `app.close()`) exits `1`
   instead, so an orchestrator's own health checks and exit-code monitoring
   see the difference between a clean stop and a broken one.

## What each worker does

| Worker | New work | In-flight work | Drain bound |
|---|---|---|---|
| HTTP requests | Nest stops accepting new connections as part of `app.close()`. | Requests already being handled complete normally. | Orchestrator's own SIGKILL grace period. |
| `AnchoringWorkerService` (blockchain anchoring poll, every 10s) | `poll()` becomes a no-op as soon as `draining` is set — see `onApplicationShutdown`. | The current poll cycle (`resetStaleProcessing` + `processBatch`, at most `BATCH_SIZE` intents) is awaited. | 25s (`SHUTDOWN_DRAIN_TIMEOUT_MS`). |
| `RetentionJob` (daily cron sweep) | Not wired to shutdown — a daily batch job is astronomically unlikely to be mid-run when a deploy happens, and it already has its own in-process re-entrancy guard (`RetentionCleanupService`) that makes an interrupted run safe to simply re-run on the next tick. | — | — |

### Why `AnchoringWorkerService` never leaves a half-committed write

Each claimed intent is written `CONFIRMED` or `FAILED`/`PENDING` (retry) in a
single statement (`FAILED`/retry path) or a single `$transaction` (`CONFIRMED`
path — see `executeIntent`). There is no intermediate state a crash between
two writes could leave behind. If the drain timeout is hit while a batch is
still executing:

- Any intent whose write already landed is correctly terminal.
- Any intent still mid-flight is left `PROCESSING`. `resetStaleProcessing`
  reclaims rows stuck in `PROCESSING` past `STALE_PROCESSING_THRESHOLD_MS`
  (5 minutes) on the **next** healthy worker's tick — this is the same
  mechanism that already recovers from a hard crash, not new machinery added
  for shutdown.

This is why the drain bound (25s) can be short relative to the stale-recovery
window (5 minutes): a timed-out drain does not lose work, it just defers
recovery to the existing self-healing path.

## Forced termination

If the orchestrator's SIGKILL grace period elapses before shutdown finishes
(clock skew between the 25s drain bound and the platform's own grace period,
a stuck CLI call, etc.), the process is killed without running the rest of
the sequence. This is recoverable without duplicate committed side effects,
by the same mechanism as an ordinary crash:

- Any anchoring intent left `PROCESSING` is reclaimed by
  `resetStaleProcessing` within 5 minutes.
- Idempotency guards already in `executeIntent` (the `(proofId, operation)`
  CONFIRMED lookup) prevent a reclaimed intent from double-anchoring even if
  the original CLI call actually succeeded before the kill.

## Verifying it

Integration coverage: `src/jobs/anchoring-worker.service.spec.ts`
(`onApplicationShutdown` describe block) and
`src/health/health.service.spec.ts` (`beginShutdown` describe block) exercise
the drain-then-timeout behavior and the readiness flip directly.

To verify by hand against a running instance:

```bash
# 1. Confirm readiness is currently "ready".
curl -s localhost:3000/api/v1/health/ready | jq .status

# 2. Trigger an anchoring poll cycle, then send SIGTERM immediately after.
#    (In a real deploy this is the orchestrator's own stop signal.)
kill -TERM <pid>

# 3. Readiness should flip to "not_ready" within the same request that was
#    in flight when the signal arrived — no window where it still reports
#    "ready" after SIGTERM.
curl -s localhost:3000/api/v1/health/ready   # expect 503 / not_ready

# 4. Logs should show, in order:
#    "Received SIGTERM — starting graceful shutdown"
#    "Draining: no new poll cycles will start (signal=SIGTERM)"
#    "In-flight poll cycle finished draining"  (or the 25s timeout warning)
#    "Shutdown complete"
```
