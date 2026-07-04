import { describe, expect, it } from "vitest";

import { sanitizeReturnTo } from "../lib/return-to";

// `returnTo` carries the page a user was on across the sign-in/sign-up → OAuth
// → callback round-trip so re-auth lands them back where they were. It is
// attacker-influençable (it rides in the URL), so it MUST be sanitised to a
// same-origin relative path — anything else is an open-redirect vector.
describe("sanitizeReturnTo", () => {
  it("keeps a plain absolute path", () => {
    expect(sanitizeReturnTo("/tickets/abc")).toBe("/tickets/abc");
  });

  it("keeps an absolute path with a query string", () => {
    expect(sanitizeReturnTo("/tickets?status=open&page=2")).toBe(
      "/tickets?status=open&page=2",
    );
  });

  it("falls back to '/' for null/undefined/empty", () => {
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo(undefined)).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
  });

  it("uses a caller-supplied fallback when the value is absent", () => {
    expect(sanitizeReturnTo(undefined, "/onboarding")).toBe("/onboarding");
    expect(sanitizeReturnTo("/tickets", "/onboarding")).toBe("/tickets");
  });

  it("rejects a protocol-relative URL (//evil.com)", () => {
    expect(sanitizeReturnTo("//evil.com/phish")).toBe("/");
  });

  it("rejects an absolute http(s) URL", () => {
    expect(sanitizeReturnTo("https://evil.com")).toBe("/");
    expect(sanitizeReturnTo("http://evil.com")).toBe("/");
  });

  it("rejects a path that does not start with a slash", () => {
    expect(sanitizeReturnTo("tickets/abc")).toBe("/");
    expect(sanitizeReturnTo("javascript:alert(1)")).toBe("/");
  });

  it("rejects backslash tricks browsers normalise to //", () => {
    expect(sanitizeReturnTo("/\\evil.com")).toBe("/");
    expect(sanitizeReturnTo("/tickets\\..\\admin")).toBe("/");
  });

  it("rejects values with control characters or whitespace", () => {
    expect(sanitizeReturnTo("/tickets\nSet-Cookie: x")).toBe("/");
    expect(sanitizeReturnTo("/ca ses")).toBe("/");
  });
});
