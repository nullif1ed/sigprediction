/**
 * Sliding-window limiter for a per-minute budget: at most `capacity` requests in any trailing
 * 60 seconds. (A token bucket that starts full can burst to ~2x the budget in the first minute,
 * which is exactly what trips a server-side per-minute limit.)
 * `pause(ms)` blocks every caller (used when the server returns 429 Retry-After).
 */
export class RateLimiter {
  readonly capacity: number;
  private stamps: number[] = [];
  private pausedUntil = 0;
  used = 0;

  constructor(
    perMinute: number,
    private now: () => number = () => Date.now(),
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private windowMs = 60_000,
  ) {
    this.capacity = Math.max(1, Math.floor(perMinute));
  }

  private prune() {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
  }

  /** Requests still allowed in the current window. */
  available(): number {
    if (this.now() < this.pausedUntil) return 0;
    this.prune();
    return this.capacity - this.stamps.length;
  }

  usedLastMinute(): number {
    this.prune();
    return this.stamps.length;
  }

  tryAcquire(): boolean {
    if (this.available() <= 0) return false;
    this.stamps.push(this.now());
    this.used++;
    return true;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const paused = this.pausedUntil - this.now();
      if (paused > 0) {
        await this.sleep(paused);
        continue;
      }
      if (this.tryAcquire()) return;
      await this.sleep(Math.max(5, this.stamps[0] + this.windowMs - this.now() + 1));
    }
  }

  pause(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  get pausedFor(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }
}
