// In-memory login-attempt throttle for the operator console (S10).
//
// The admin app authenticates with a single shared password, so brute force
// is the primary threat. This is a deliberately simple counter with
// exponential backoff: the app is a single-instance operator tool, so
// process-local state is acceptable (a restart clears it — an attacker who
// can restart the process has bigger levers). For defence in depth, deploy
// behind an IP allowlist or Cloudflare Access.
//
// The pure functions below are unit-tested; `sharedThrottle` is the
// module-level singleton the login action uses.

/** Failures allowed before any delay kicks in. */
export const FREE_ATTEMPTS = 3;
/** Backoff cap — 5 minutes between attempts at the limit. */
export const MAX_LOCK_MS = 5 * 60 * 1000;

export interface ThrottleState {
  /** Consecutive failed attempts since the last success. */
  readonly failures: number;
  /** Epoch ms until which further attempts are refused. */
  readonly lockedUntilMs: number;
}

export const createThrottleState = (): ThrottleState => ({
  failures: 0,
  lockedUntilMs: 0,
});

/** Lock duration after the `failures`-th consecutive failure: 1s, 2s, 4s, … capped. */
export const lockMsFor = (failures: number): number => {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(MAX_LOCK_MS, 1000 * 2 ** (failures - FREE_ATTEMPTS));
};

/** Milliseconds the caller must wait before the next attempt (0 = go ahead). */
export const retryAfterMs = (state: ThrottleState, nowMs: number): number =>
  Math.max(0, state.lockedUntilMs - nowMs);

export const recordFailure = (
  state: ThrottleState,
  nowMs: number,
): ThrottleState => {
  const failures = state.failures + 1;
  return { failures, lockedUntilMs: nowMs + lockMsFor(failures) };
};

export const recordSuccess = (): ThrottleState => createThrottleState();

// ---- Module-level singleton used by the login action ----

let shared: ThrottleState = createThrottleState();

export const sharedThrottle = {
  retryAfterMs: (nowMs: number): number => retryAfterMs(shared, nowMs),
  recordFailure: (nowMs: number): void => {
    shared = recordFailure(shared, nowMs);
  },
  recordSuccess: (): void => {
    shared = recordSuccess();
  },
};
