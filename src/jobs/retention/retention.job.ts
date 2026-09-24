import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { RetentionCleanupService } from "./retention-cleanup.service";

/**
 * Schedules the retention sweep.
 *
 * Kept separate from {@link RetentionCleanupService} so the sweep can be
 * exercised — and invoked manually by an operator — without a scheduler
 * attached. That separation is also what lets the service be tested against
 * pinned clocks without fighting cron.
 *
 * Defaults to a daily run outside peak hours. Retention is measured in days, so
 * running more often buys nothing and only adds database contention.
 */
@Injectable()
export class RetentionJob {
  private readonly logger = new Logger(RetentionJob.name);

  constructor(private readonly cleanup: RetentionCleanupService) {}

  @Cron(process.env.RETENTION_CLEANUP_CRON ?? CronExpression.EVERY_DAY_AT_3AM)
  async sweep(): Promise<void> {
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
  }
}
