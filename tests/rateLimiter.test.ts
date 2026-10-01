import { describe, expect, it } from "vitest";
import { RateLimiter } from "@/lib/server/rateLimiter";

describe("rate limiter", () => {
  it("enforces the per-minute budget and refills over time", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter(60, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    for (let i = 0; i < 60; i++) expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(false);
    await rl.acquire(); // sliding window: waits until the oldest request leaves the 60s window
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
    expect(rl.usedLastMinute()).toBe(1);
  });

  it("never allows more than the budget in any trailing minute", () => {
    let t = 0;
    const rl = new RateLimiter(100, () => t);
    let count = 0;
    for (let ms = 0; ms < 120_000; ms += 100) {
      t = ms;
      if (rl.tryAcquire()) count++;
      expect(rl.usedLastMinute()).toBeLessThanOrEqual(100);
    }
    expect(count).toBe(200);
  });

  it("pauses everyone after a 429", async () => {
    let t = 0;
    const rl = new RateLimiter(100, () => t, async (ms) => void (t += ms));
    rl.pause(60_000);
    expect(rl.tryAcquire()).toBe(false);
    await rl.acquire();
    expect(t).toBeGreaterThanOrEqual(60_000);
  });
});
