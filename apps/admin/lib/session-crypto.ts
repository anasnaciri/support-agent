import { createHmac, timingSafeEqual } from "node:crypto";

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

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** Issue a signed session value: `base64url({iat}).hmac`. */
export const signSessionValue = (issuedAtMs: number): string => {
  const payload = b64url(Buffer.from(JSON.stringify({ iat: issuedAtMs })));
  return `${payload}.${sign(payload)}`;
};

/** Verify signature + freshness. `nowMs` is injected so tests are deterministic. */
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
    ) as { iat?: unknown };
    if (typeof decoded.iat !== "number") return false;
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
