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
