import { describe, it, expect } from "vitest";

import { isAccessTokenExpired } from "../lib/session-expiry";

describe("isAccessTokenExpired", () => {
  const now = 1_700_000_000_000; // fixed ms
  const nowSec = now / 1000;

  it("treats a missing exp as not expired (trust the cookie seal)", () => {
    expect(isAccessTokenExpired(undefined, now)).toBe(false);
  });

  it("treats a future exp as not expired", () => {
    expect(isAccessTokenExpired(nowSec + 60, now)).toBe(false);
  });

  it("treats a past exp as expired", () => {
    expect(isAccessTokenExpired(nowSec - 60, now)).toBe(true);
  });

  it("treats exp exactly at now as expired (boundary is <=)", () => {
    expect(isAccessTokenExpired(nowSec, now)).toBe(true);
  });
});
