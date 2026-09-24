import { Logger } from "@nestjs/common";
import {
  formatContext,
  redact,
  redactError,
  type LogContext,
} from "./redaction";

/**
 * A logger that redacts before it writes.
 *
 * Wraps the Nest `Logger` rather than replacing it, so existing call sites keep
 * working and adoption can be incremental. The difference is that every message
 * passes through {@link redact} and every context field is checked against the
 * forbidden-field list.
 *
 * Correlation lives here, not in metrics. A request ID or job run ID is a
 * high-cardinality value that is exactly right as a log field and exactly wrong
 * as a metric label: logs are queried by identifier, metrics are aggregated by
 * dimension. Keeping the two separate is what lets an operator pivot from "the
 * anchoring error rate rose" to "here are the twelve affected runs" without
 * ever putting a run ID into a time series.
 */
export class OperationalLogger {
  private readonly logger: Logger;

  constructor(context: string) {
    this.logger = new Logger(context);
  }

  /** Routine progress. Safe to sample or drop under load. */
  log(message: string, context?: LogContext): void {
    this.logger.log(`${redact(message)}${formatContext(context)}`);
  }

  /** A condition worth noticing that did not fail the operation. */
  warn(message: string, context?: LogContext): void {
    this.logger.warn(`${redact(message)}${formatContext(context)}`);
  }

  /**
   * A failed operation.
   *
   * The `cause` is rendered through {@link redactError}, which keeps the
   * exception's class name and a redacted message but never the stack. Stacks
   * carry file paths and, in some frames, argument values; the class name plus
   * the correlation ID is enough to find the run and inspect it directly.
   */
  error(message: string, cause?: unknown, context?: LogContext): void {
    const suffix = cause === undefined ? "" : ` cause="${redactError(cause)}"`;
    this.logger.error(`${redact(message)}${suffix}${formatContext(context)}`);
  }

  /** Verbose detail, off in production. Redacted regardless. */
  debug(message: string, context?: LogContext): void {
    this.logger.debug(`${redact(message)}${formatContext(context)}`);
  }
}
