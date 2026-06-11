import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Pure session-token + password helpers — no Next imports, so they're unit
// testable. The Next cookie/redirect glue lives in `session.ts`.

export const SESSION_COOKIE = "admin_session";
export const SESSION_MAX_AGE_S = 8 * 60 * 60;

const sessionSecret = (): string => {
  const v = process.env["ADMIN_SESSION_SECRET"];
  if (!v || v.trim().length === 0) {
    throw new Error("ADMIN_SESSION_SECRET is required (admin session signing key)");
  }
  return v;
};

const b64url = (b: Buffer): string => b.toString("base64url");

const sign = (payload: string): string =>
  b64url(createHmac("sha256", sessionSecret()).update(payload).digest());

// Constant-time string compare with no early return on length mismatch
// (S10): hash both sides to a fixed 32 bytes first, so neither the timing
// nor the comparison itself leaks the expected value's length.
const constantTimeEqual = (a: string, b: string): boolean => {
  const ah = createHash("sha256").update(a, "utf8").digest();
  const bh = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ah, bh);
};

// Key-version of the current ADMIN_SESSION_SECRET, embedded in every session
// payload. Rotating ADMIN_SESSION_SECRET is the documented "log every
// operator out NOW" lever: the HMAC stops verifying AND the kid stops
// matching, so no token issued under the old secret survives (S10). Rotate
// the secret after rotating ADMIN_DASHBOARD_PASSWORD — password rotation
// alone does not invalidate live sessions.
const keyVersion = (): string =>
  createHash("sha256").update(sessionSecret(), "utf8").digest("hex").slice(0, 8);

/** Issue a signed session value: `base64url({iat, kid}).hmac`. */
export const signSessionValue = (issuedAtMs: number): string => {
  const payload = b64url(
    Buffer.from(JSON.stringify({ iat: issuedAtMs, kid: keyVersion() })),
  );
  return `${payload}.${sign(payload)}`;
};

/** Verify signature + key-version + freshness. `nowMs` is injected so tests are deterministic. */
export const verifySessionValue = (
  value: string | undefined,
  nowMs: number,
): boolean => {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!constantTimeEqual(sig, sign(payload))) return false;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { iat?: unknown; kid?: unknown };
    if (typeof decoded.iat !== "number") return false;
    // Belt-and-braces with the HMAC above: a payload stamped under a
    // different (or no) key-version never verifies, even if a signature
    // somehow checked out. Also retires pre-kid legacy tokens outright.
    if (decoded.kid !== keyVersion()) return false;
    return nowMs - decoded.iat >= 0 && nowMs - decoded.iat < SESSION_MAX_AGE_S * 1000;
  } catch {
    return false;
  }
};

/** Constant-time compare against the configured operator password. */
export const passwordMatches = (input: string): boolean => {
  const expected = process.env["ADMIN_DASHBOARD_PASSWORD"];
  if (!expected || expected.length === 0) {
    throw new Error("ADMIN_DASHBOARD_PASSWORD is required (operator login)");
  }
  return constantTimeEqual(input, expected);
};
