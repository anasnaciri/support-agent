import { describe, expect, it } from "vitest";

import {
  FREE_ATTEMPTS,
  MAX_LOCK_MS,
  createThrottleState,
  lockMsFor,
  recordFailure,
  recordSuccess,
  retryAfterMs,
} from "../lib/login-throttle.js";

// S10: the shared operator password must not be brute-forceable. A small
// in-memory counter with exponential backoff is acceptable for this
// single-instance operator app.
describe("admin login throttle", () => {
  it("allows the first few attempts without delay", () => {
    let s = createThrottleState();
    const now = 1_000_000;
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      expect(retryAfterMs(s, now)).toBe(0);
      s = recordFailure(s, now);
    }
    expect(retryAfterMs(s, now)).toBeGreaterThan(0);
  });

  it("backs off exponentially after the free attempts", () => {
    expect(lockMsFor(FREE_ATTEMPTS)).toBe(1000);
    expect(lockMsFor(FREE_ATTEMPTS + 1)).toBe(2000);
    expect(lockMsFor(FREE_ATTEMPTS + 2)).toBe(4000);
  });

  it("caps the backoff", () => {
    expect(lockMsFor(FREE_ATTEMPTS + 50)).toBe(MAX_LOCK_MS);
  });

  it("unlocks once the lock window has elapsed", () => {
    let s = createThrottleState();
    const now = 1_000_000;
    for (let i = 0; i < FREE_ATTEMPTS; i++) s = recordFailure(s, now);
    expect(retryAfterMs(s, now)).toBe(1000);
    expect(retryAfterMs(s, now + 1000)).toBe(0);
  });

  it("a success clears the counter entirely", () => {
    let s = createThrottleState();
    const now = 1_000_000;
    for (let i = 0; i < FREE_ATTEMPTS + 3; i++) s = recordFailure(s, now);
    s = recordSuccess();
    expect(retryAfterMs(s, now)).toBe(0);
    expect(s.failures).toBe(0);
  });

  it("failures while locked keep extending the lock", () => {
    let s = createThrottleState();
    const now = 1_000_000;
    for (let i = 0; i < FREE_ATTEMPTS + 1; i++) s = recordFailure(s, now);
    // Locked for 2s now; a failure at +1s restarts a longer lock from there.
    s = recordFailure(s, now + 1000);
    expect(retryAfterMs(s, now + 1000)).toBe(4000);
  });
});
