import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { RetentionCleanupService } from "./retention-cleanup.service";
import { DistributedLeaseService } from "../distributed-lease.service";

/**
 * Duration to hold the retention cleanup job lease (24 hours).
 * Sufficient for daily cleanup jobs; gives ample time for slow runs.
 */
const RETENTION_CLEANUP_LEASE_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Unique identifier for the retention cleanup job lease.
 * Used across all instances to coordinate single execution.
 */
const RETENTION_CLEANUP_JOB_NAME = "retention_cleanup";

/**
 * Schedules the retention sweep with distributed lease coordination.
 *
 * Kept separate from {@link RetentionCleanupService} so the sweep can be
 * exercised — and invoked manually by an operator — without a scheduler
 * attached. That separation is also what lets the service be tested against
 * pinned clocks without fighting cron.
 *
 * Defaults to a daily run outside peak hours. Retention is measured in days, so
 * running more often buys nothing and only adds database contention.
 *
 * With distributed leases, only one instance executes the sweep at a time,
 * preventing duplicate deletions and reducing database load in multi-instance deployments.
 */
@Injectable()
export class RetentionJob {
  private readonly logger = new Logger(RetentionJob.name);

  constructor(
    private readonly cleanup: RetentionCleanupService,
    private readonly leaseService: DistributedLeaseService,
  ) {}

  @Cron(process.env.RETENTION_CLEANUP_CRON ?? CronExpression.EVERY_DAY_AT_3AM)
  async sweep(): Promise<void> {
    const leaseResult = await this.leaseService.acquireLease(
      RETENTION_CLEANUP_JOB_NAME,
      RETENTION_CLEANUP_LEASE_DURATION_MS,
    );

    if (!leaseResult.acquired) {
      this.logger.debug(
        `Retention cleanup lease held by another instance (${leaseResult.owner}); skipping sweep`,
      );
      return;
    }

    try {
      // `RETENTION_DRY_RUN=true` reports what would be removed without writing.
      // The intended workflow after a retention change: enable it, read the
      // counts, then disable it once the numbers look right.
      const dryRun = process.env.RETENTION_DRY_RUN === "true";

      const result = await this.cleanup.run({ dryRun });

      if (result.skipped) {
        // Not an error. A previous run outlasted its interval, which the
        // in-process guard handles; the next tick picks the work up.
        return;
      }

      // Counts only, per class. Never the identity of what was removed.
      for (const entry of result.results) {
        if (entry.affected === 0 && !entry.truncated) continue;

        const suffix = entry.truncated ? " (batch cap reached)" : "";
        this.logger.log(
          `${entry.key}: ${entry.affected} record(s) ` +
            `${entry.dryRun ? "eligible" : "removed"}${suffix}`,
        );
      }
    } finally {
      // Renewal: extend the lease before exiting
      await this.leaseService.renewLease(
        RETENTION_CLEANUP_JOB_NAME,
        RETENTION_CLEANUP_LEASE_DURATION_MS,
      );
    }
  }
}
