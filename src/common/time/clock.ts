import { Injectable } from "@nestjs/common";

/**
 * Injectable wall-clock abstraction (nester... — earnproof-backend#66).
 *
 * Domain services that need "now" (session expiry, retention cutoffs,
 * proof/credential windows) should depend on `Clock` instead of calling
 * `new Date()` / `Date.now()` directly. That makes clock-skew and
 * time-boundary behavior testable without real sleeps: swap in a
 * `FixedClock` (see `test/time/fixed-clock.ts`) and advance it explicitly.
 *
 * `SystemClock` is the production implementation, registered as `Clock` in
 * `CommonModule` — see that module for wiring.
 */
export abstract class Clock {
  /** The current instant. Equivalent to `new Date()` for `SystemClock`. */
  abstract now(): Date;

  /** Convenience: `now()` as epoch milliseconds. Equivalent to `Date.now()`. */
  nowMs(): number {
    return this.now().getTime();
  }
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
