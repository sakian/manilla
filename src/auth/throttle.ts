/**
 * A widening delay after failed sign-in attempts (#14).
 *
 * A recovery code carries 60 bits, so guessing one over HTTP is not a threat
 * model today. But that argument rests on a constant staying where it is, and
 * it gave no signal: a thousand wrong codes looked exactly like none. This puts
 * a cost on the thousandth, and the caller logs every failure, so trying shows.
 *
 * Counted per install rather than per address. There is one user, and behind
 * `tailscale serve` every request reaches the app from the same loopback
 * address, so an address would key nothing - and a header naming one is
 * something the sender writes. The price is that someone hammering the endpoint
 * delays the owner's recovery too, by at most `maxMs`; a passkey still works.
 *
 * Kept in memory: a restart forgets the count, and nothing a guesser can do
 * causes one.
 */

export type ThrottleOptions = {
  /** Failures allowed before any delay. */
  free: number;
  /** The first delay; each further failure doubles it. */
  baseMs: number;
  maxMs: number;
  /** How long after the last failure the count is forgotten. */
  forgetAfterMs: number;
};

type Record = { failures: number; lastFailure: number };

export class Throttle {
  private readonly records = new Map<string, Record>();
  private readonly options: ThrottleOptions;

  constructor(options: ThrottleOptions) {
    this.options = options;
  }

  private current(key: string, now: number): Record | undefined {
    const record = this.records.get(key);
    if (record && now - record.lastFailure >= this.options.forgetAfterMs) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  /** How long the n-th failure in a row makes the next attempt wait. */
  delayAfter(failures: number): number {
    const { free, baseMs, maxMs } = this.options;
    if (failures <= free) return 0;
    return Math.min(maxMs, baseMs * 2 ** (failures - free - 1));
  }

  /** Milliseconds before another attempt is allowed, or 0. */
  waitFor(key: string, now: number = Date.now()): number {
    const record = this.current(key, now);
    if (!record) return 0;
    return Math.max(0, record.lastFailure + this.delayAfter(record.failures) - now);
  }

  /** Count a failure; returns how many there have been and the wait it brings. */
  failed(key: string, now: number = Date.now()): { failures: number; waitMs: number } {
    const failures = (this.current(key, now)?.failures ?? 0) + 1;
    this.records.set(key, { failures, lastFailure: now });
    return { failures, waitMs: this.delayAfter(failures) };
  }

  /** A success clears the count, so the owner is not left paying for a typo. */
  succeeded(key: string): void {
    this.records.delete(key);
  }
}

/** Recovery codes: five tries free, then 1s doubling to 15 minutes, forgotten after an hour. */
export const recoveryThrottle = new Throttle({
  free: 5,
  baseMs: 1_000,
  maxMs: 15 * 60_000,
  forgetAfterMs: 60 * 60_000,
});

/** "45 seconds", "3 minutes" - rounded up, since waiting less than this fails. */
export function describeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
