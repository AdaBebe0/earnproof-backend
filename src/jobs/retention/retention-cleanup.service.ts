import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import {
  cutoffFor,
  DisposalMethod,
  RetentionConfigError,
  SWEEPABLE_CLASSES,
  SweepMode,
  type RetentionClass,
} from "./retention-policy";

/**
 * Bounded, resumable cleanup of expired operational records.
 *
 * Three properties shape the implementation:
 *
 * **Bounded.** Every pass deletes at most {@link BATCH_SIZE} rows, selected by
 * an indexed cutoff column. An unbounded `deleteMany` on a large table takes
 * locks for as long as it runs, which turns a routine sweep into a database
 * incident — exactly the failure the anchoring worker's batching already avoids.
 *
 * **Resumable.** Progress is the deletion itself. There is no cursor to persist:
 * a run that dies halfway leaves fewer eligible rows, and the next run continues
 * from wherever it stopped. This is what makes a crash mid-sweep uninteresting.
 *
 * **Coordinated.** An in-process guard prevents a slow run from overlapping the
 * next scheduled tick. Multi-instance coordination requires a shared lock and is
 * called out in `docs/data-retention.md` as a deliberate limitation rather than
 * left as an assumption.
 */

/** Rows removed per statement. Small enough to keep lock duration short. */
const BATCH_SIZE = 500;

/**
 * Maximum batches per class per run.
 *
 * Caps the work one tick can do, so a large backlog drains over several runs
 * instead of monopolising the database in one. The remainder is reported rather
 * than silently dropped.
 */
const MAX_BATCHES_PER_RUN = 20;

/** Outcome of sweeping one retention class. */
export interface ClassSweepResult {
  /** Retention class key. */
  key: string;
  /** Rows removed or anonymised. A count only — never record content. */
  affected: number;
  /** Batches executed. */
  batches: number;
  /** True when the batch cap was hit and eligible rows remain. */
  truncated: boolean;
  /** True when nothing was written because this was a dry run. */
  dryRun: boolean;
}

/** Outcome of one complete run. */
export interface RetentionRunResult {
  results: ClassSweepResult[];
  /** Total rows affected across all classes. */
  totalAffected: number;
  /** True when another run was already in progress and this one yielded. */
  skipped: boolean;
}

/** Options for a single run. */
export interface RetentionRunOptions {
  /**
   * Report what would be removed without writing.
   *
   * The mechanism an operator uses to check a retention change before it
   * destroys anything.
   */
  dryRun?: boolean;
  /** Restrict the run to specific class keys. Defaults to all sweepable classes. */
  only?: readonly string[];
  /** Injected clock, so cutoff boundaries can be pinned in tests. */
  now?: Date;
}

@Injectable()
export class RetentionCleanupService {
  private readonly logger = new Logger(RetentionCleanupService.name);

  /**
   * In-process single-run guard.
   *
   * A sweep that outlives its interval must not overlap the next tick: two
   * concurrent runs would contend for the same rows and double the lock
   * pressure the batching exists to avoid.
   */
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /** True while a run is in progress. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Sweeps every eligible retention class.
   *
   * Returns `skipped: true` rather than queueing or throwing when a run is
   * already in progress. Cleanup is idempotent and scheduled; a skipped tick
   * costs nothing, whereas a queued one would compound the overload that made
   * the first run slow.
   */
  async run(options: RetentionRunOptions = {}): Promise<RetentionRunResult> {
    if (this.running) {
      this.logger.warn(
        "Retention cleanup already in progress; skipping this run",
      );
      return { results: [], totalAffected: 0, skipped: true };
    }

    this.running = true;

    try {
      const now = options.now ?? new Date();
      const selected = this.selectClasses(options.only);
      const results: ClassSweepResult[] = [];

      for (const entry of selected) {
        // One class failing must not abandon the rest. A misconfigured
        // duration on webhook deliveries should not stop challenges from
        // being swept.
        try {
          results.push(await this.sweepClass(entry, now, options.dryRun ?? false));
        } catch (error) {
          this.logger.error(
            `Retention sweep failed for ${entry.key}: ${describe(error)}`,
          );
          results.push({
            key: entry.key,
            affected: 0,
            batches: 0,
            truncated: false,
            dryRun: options.dryRun ?? false,
          });
        }
      }

      const totalAffected = results.reduce(
        (sum, result) => sum + result.affected,
        0,
      );

      // Counts only. What was deleted is never logged.
      this.logger.log(
        `Retention cleanup ${options.dryRun ? "(dry run) " : ""}` +
          `affected ${totalAffected} record(s) across ${results.length} class(es)`,
      );

      return { results, totalAffected, skipped: false };
    } finally {
      this.running = false;
    }
  }

  /**
   * Sweeps one class in bounded batches until it is drained or capped.
   */
  private async sweepClass(
    entry: RetentionClass,
    now: Date,
    dryRun: boolean,
  ): Promise<ClassSweepResult> {
    this.assertSweepable(entry);

    const cutoff = cutoffFor(entry, now);
    const delegate = this.delegateFor(entry);

    if (dryRun) {
      // Counting is bounded by the same index the deletion would use, so a dry
      // run costs roughly one batch's worth of work regardless of backlog size.
      const eligible = await delegate.count({
        where: this.eligibilityFilter(entry, cutoff),
      });

      return {
        key: entry.key,
        affected: eligible,
        batches: 0,
        truncated: false,
        dryRun: true,
      };
    }

    let affected = 0;
    let batches = 0;

    while (batches < MAX_BATCHES_PER_RUN) {
      // Select ids first, then act on exactly those. Selecting by id keeps each
      // write statement small and makes the operation safe to interrupt: a
      // crash between selection and deletion loses nothing, because the same
      // rows remain eligible next run.
      const candidates: Array<{ id: string }> = await delegate.findMany({
        where: this.eligibilityFilter(entry, cutoff),
        select: { id: true },
        orderBy: { [entry.cutoffColumn]: "asc" },
        take: BATCH_SIZE,
      });

      if (candidates.length === 0) {
        return { key: entry.key, affected, batches, truncated: false, dryRun: false };
      }

      const ids = candidates.map((row) => row.id);

      const result = await delegate.deleteMany({ where: { id: { in: ids } } });

      affected += result.count;
      batches += 1;

      // A short batch means the eligible set is drained.
      if (candidates.length < BATCH_SIZE) {
        return { key: entry.key, affected, batches, truncated: false, dryRun: false };
      }
    }

    // The cap was reached with rows still eligible. Reported, never silent:
    // a truncated sweep that looked complete would let a backlog grow unseen.
    this.logger.warn(
      `Retention sweep for ${entry.key} hit the ${MAX_BATCHES_PER_RUN}-batch cap ` +
        `after ${affected} record(s); remaining rows will be swept next run`,
    );

    return { key: entry.key, affected, batches, truncated: true, dryRun: false };
  }

  /**
   * Eligibility filter for a class.
   *
   * Every filter is anchored on an indexed cutoff column, so the scan stays
   * bounded. Classes with additional conditions declare them here rather than
   * relying on the caller to remember — the failed-anchoring class in
   * particular must never match a pending or confirmed intent.
   */
  private eligibilityFilter(
    entry: RetentionClass,
    cutoff: Date,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      [entry.cutoffColumn]: { lt: cutoff },
    };

    if (entry.key === "failed_anchoring_intents") {
      // Only permanently-failed intents. Anchoring state for pending and
      // confirmed work is preserved; sweeping a confirmed intent would discard
      // the transaction hash linking a proof to the ledger.
      base.status = "FAILED";
      base.permanentError = true;
    }

    if (entry.key === "auth_sessions") {
      // A session that has been rotated is still referenced by its successor.
      // Deleting it would break the rotation chain, so only unreferenced
      // sessions are eligible.
      base.rotatedToId = null;
    }

    return base;
  }

  /**
   * Guards against a preserved class reaching the sweep.
   *
   * `SWEEPABLE_CLASSES` already excludes them, so this is defence in depth: the
   * cost of the check is negligible next to the cost of deleting proof evidence.
   *
   * The disposal check is part of the same guard. Every sweepable class deletes;
   * the classes marked for anonymisation are all preserved, and the sweep has no
   * anonymisation path. If a future class pairs `AUTOMATED` with `ANONYMISE`, it
   * must fail loudly here rather than be silently deleted instead.
   */
  private assertSweepable(entry: RetentionClass): void {
    if (entry.sweep !== SweepMode.AUTOMATED) {
      throw new RetentionConfigError(
        `Retention class ${entry.key} is preserved and must never be swept ` +
          `automatically. ${entry.preservationReason ?? ""}`.trim(),
      );
    }

    if (entry.disposal !== DisposalMethod.DELETE) {
      throw new RetentionConfigError(
        `Retention class ${entry.key} is marked for ${entry.disposal} but the ` +
          `cleanup job only implements deletion. Implement anonymisation ` +
          `explicitly before marking this class sweepable.`,
      );
    }
  }

  /** Resolves the class keys to sweep for this run. */
  private selectClasses(only?: readonly string[]): readonly RetentionClass[] {
    if (!only || only.length === 0) return SWEEPABLE_CLASSES;

    const selected = SWEEPABLE_CLASSES.filter((entry) =>
      only.includes(entry.key),
    );

    const unknown = only.filter(
      (key) => !SWEEPABLE_CLASSES.some((entry) => entry.key === key),
    );

    if (unknown.length > 0) {
      // Includes the case where a caller names a preserved class. Failing is
      // the point: silently sweeping nothing would look like success.
      throw new RetentionConfigError(
        `Unknown or non-sweepable retention class(es): ${unknown.join(", ")}.`,
      );
    }

    return selected;
  }

  /** Prisma delegate for a class's model. */
  private delegateFor(entry: RetentionClass): PrismaDelegate {
    const delegates: Record<string, PrismaDelegate | undefined> = {
      wallet_challenges: this.prisma.walletChallenge as unknown as PrismaDelegate,
      auth_sessions: this.prisma.authSession as unknown as PrismaDelegate,
      webhook_deliveries: this.prisma
        .webhookDelivery as unknown as PrismaDelegate,
      verification_events: this.prisma
        .verificationEventLog as unknown as PrismaDelegate,
      audit_logs: this.prisma.auditLog as unknown as PrismaDelegate,
      failed_anchoring_intents: this.prisma
        .anchoringIntent as unknown as PrismaDelegate,
    };

    const delegate = delegates[entry.key];
    if (!delegate) {
      throw new RetentionConfigError(
        `No Prisma delegate is mapped for retention class ${entry.key}.`,
      );
    }
    return delegate;
  }
}

/** The subset of a Prisma model delegate the sweep uses. */
interface PrismaDelegate {
  count(args: { where: Record<string, unknown> }): Promise<number>;
  findMany(args: {
    where: Record<string, unknown>;
    select: { id: true };
    orderBy: Record<string, "asc" | "desc">;
    take: number;
  }): Promise<Array<{ id: string }>>;
  deleteMany(args: {
    where: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

/** Error description safe for an operational log. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "UnknownError";
}
