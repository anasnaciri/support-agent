import { beforeEach, describe, expect, it } from "vitest";
import {
  passwordMatches,
  signSessionValue,
  verifySessionValue,
  SESSION_MAX_AGE_S,
} from "../lib/session-crypto.js";

describe("admin session-crypto", () => {
  beforeEach(() => {
    process.env["ADMIN_SESSION_SECRET"] = "test-session-secret";
    process.env["ADMIN_DASHBOARD_PASSWORD"] = "hunter2";
  });

  it("sign → verify round-trips a fresh token", () => {
    const now = 1_000_000;
    expect(verifySessionValue(signSessionValue(now), now)).toBe(true);
  });

  it("rejects a tampered signature or payload", () => {
    const value = signSessionValue(1000);
    expect(verifySessionValue(`${value}x`, 1000)).toBe(false);
    const payload = value.slice(0, value.indexOf("."));
    expect(verifySessionValue(`${payload}.deadbeef`, 1000)).toBe(false);
  });

  it("rejects an expired token", () => {
    const now = 1_000_000;
    const value = signSessionValue(now);
    expect(verifySessionValue(value, now + SESSION_MAX_AGE_S * 1000 + 1)).toBe(
      false,
    );
  });

  it("rejects undefined / malformed values", () => {
    expect(verifySessionValue(undefined, 1)).toBe(false);
    expect(verifySessionValue("nodot", 1)).toBe(false);
  });

  it("fails verification under a different secret", () => {
    const value = signSessionValue(1000);
    process.env["ADMIN_SESSION_SECRET"] = "other-secret";
    expect(verifySessionValue(value, 1000)).toBe(false);
  });

  it("passwordMatches is an exact constant-time compare", () => {
    expect(passwordMatches("hunter2")).toBe(true);
    expect(passwordMatches("hunter3")).toBe(false);
    expect(passwordMatches("hunter")).toBe(false);
  });
});

// S10: the session stamp embeds a key-version derived from
// ADMIN_SESSION_SECRET, so rotating the secret is the documented
// "log every operator out" lever — and pre-upgrade `{iat}`-only tokens
// are rejected outright.
describe("admin session key-version", () => {
  beforeEach(() => {
    process.env["ADMIN_SESSION_SECRET"] = "test-session-secret";
  });

  it("rejects a legacy payload without a key-version (kid)", () => {
    const payload = Buffer.from(JSON.stringify({ iat: 1000 })).toString(
      "base64url",
    );
    // Legacy tokens can't be re-signed here without the old sign(), so this
    // asserts on shape: a token whose payload lacks `kid` must never verify,
    // even with a correct signature for that payload.
    const value = `${payload}.${resignForTest(payload)}`;
    expect(verifySessionValue(value, 1000)).toBe(false);
  });

  it("passwordMatches never matches across differing lengths", () => {
    expect(passwordMatches("hunter2-and-then-some")).toBe(false);
    expect(passwordMatches("")).toBe(false);
  });
});

// Re-create the HMAC exactly as session-crypto does, so the legacy-shape test
// above exercises the kid check rather than the signature check.
import { createHmac } from "node:crypto";
const resignForTest = (payload: string): string =>
  createHmac("sha256", process.env["ADMIN_SESSION_SECRET"]!)
    .update(payload)
    .digest("base64url");
