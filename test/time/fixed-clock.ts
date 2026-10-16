import { Clock } from "../../src/common/time/clock";

/**
 * Deterministic `Clock` test double (earnproof-backend#66).
 *
 * Starts at a fixed instant and only moves when `advanceMs`/`set` is called
 * explicitly — tests never sleep to exercise expiry or retention boundaries.
 *
 * Usage:
 *   const clock = new FixedClock("2030-01-01T00:00:00.000Z");
 *   const svc = new SessionService(prisma, config, clock);
 *   clock.advanceMs(sessionTtlMs + 1); // cross the expiry boundary
 */
export class FixedClock extends Clock {
  private current: Date;

  constructor(initial: Date | string | number = new Date()) {
    super();
    this.current = new Date(initial);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Move the clock forward (or backward, with a negative value) by `ms`. */
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  /** Jump directly to a specific instant. */
  set(instant: Date | string | number): void {
    this.current = new Date(instant);
  }
}
