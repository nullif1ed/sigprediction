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
  /**
   * Adaptive share of `capacity` actually used. The budget is per ACCOUNT, shared with every
   * other client of the same key (dashboard, Vercel UI, the live trader), so after a 429 we
   * throttle down and only creep back up after a quiet period.
   */
  private scale = 1;
  private lastThrottle = 0;

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

  /** Current effective per-minute limit. */
  get limit(): number {
    const quietMin = (this.now() - this.lastThrottle) / 60_000;
    if (this.scale < 1 && quietMin >= 2) {
      this.scale = Math.min(1, this.scale + 0.05 * Math.floor(quietMin / 2));
      this.lastThrottle = this.now() - (quietMin % 2) * 60_000;
    }
    return Math.max(1, Math.floor(this.capacity * this.scale));
  }

  /** Called on a 429: cut the effective budget by 20% (floor 50%). */
  throttle() {
    this.scale = Math.max(0.5, this.scale * 0.8);
    this.lastThrottle = this.now();
  }

  /** Requests still allowed in the current window. */
  available(): number {
    if (this.now() < this.pausedUntil) return 0;
    this.prune();
    return this.limit - this.stamps.length;
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
