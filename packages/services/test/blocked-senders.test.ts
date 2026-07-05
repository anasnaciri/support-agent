import { describe, expect, it } from "vitest";

import {
  BLOCKED_SENDERS_MAX,
  decodeBlockedSenders,
  defaultBlockedSenders,
  isBlockedSender,
  normalizeBlockedSenderInput,
} from "../src/blocked-senders.js";

describe("isBlockedSender", () => {
  const blocked = {
    emails: ["spammer@gmail.com"],
    domains: ["marketing.example.com", "spam.co"],
  };

  it("matches an exactly blocked email address", () => {
    expect(isBlockedSender(blocked, ["spammer@gmail.com"])).toBe(true);
  });

  it("does not block other addresses on the same domain as a blocked email", () => {
    expect(isBlockedSender(blocked, ["friendly@gmail.com"])).toBe(false);
  });

  it("is case- and whitespace-insensitive on candidates", () => {
    expect(isBlockedSender(blocked, ["  Spammer@Gmail.COM "])).toBe(true);
  });

  it("matches an address at a blocked domain", () => {
    expect(isBlockedSender(blocked, ["news@marketing.example.com"])).toBe(
      true,
    );
  });

  it("matches an address at a subdomain of a blocked domain", () => {
    expect(isBlockedSender(blocked, ["x@em1.spam.co"])).toBe(true);
  });

  it("does not match a domain that merely ends with the blocked string", () => {
    expect(isBlockedSender(blocked, ["x@notspam.co"])).toBe(false);
  });

  it("blocks when any candidate matches (blocked Reply-To behind a clean From)", () => {
    expect(
      isBlockedSender(blocked, ["clean@shop.com", "spammer@gmail.com"]),
    ).toBe(true);
  });

  it("ignores null/undefined candidates", () => {
    expect(isBlockedSender(blocked, [null, undefined])).toBe(false);
  });

  it("never matches with the default empty lists", () => {
    expect(isBlockedSender(defaultBlockedSenders, ["x@y.com"])).toBe(false);
  });
});

describe("normalizeBlockedSenderInput", () => {
  it("classifies an address as an email entry and normalizes it", () => {
    expect(normalizeBlockedSenderInput(" User@Spam.Com ")).toEqual({
      kind: "email",
      value: "user@spam.com",
    });
  });

  it("classifies a bare domain as a domain entry", () => {
    expect(normalizeBlockedSenderInput("spam.com")).toEqual({
      kind: "domain",
      value: "spam.com",
    });
  });

  it("treats a leading @ as a domain entry", () => {
    expect(normalizeBlockedSenderInput("@Spam.Com")).toEqual({
      kind: "domain",
      value: "spam.com",
    });
  });

  it("strips a trailing dot from domains", () => {
    expect(normalizeBlockedSenderInput("spam.com.")).toEqual({
      kind: "domain",
      value: "spam.com",
    });
  });

  it("rejects a bare TLD / dotless domain", () => {
    expect(normalizeBlockedSenderInput("com")).toBeNull();
    expect(normalizeBlockedSenderInput("localhost")).toBeNull();
  });

  it("rejects invalid domains", () => {
    expect(normalizeBlockedSenderInput("not a domain")).toBeNull();
    expect(normalizeBlockedSenderInput("-bad.com")).toBeNull();
    expect(normalizeBlockedSenderInput("bad-.com")).toBeNull();
    expect(normalizeBlockedSenderInput("")).toBeNull();
    expect(normalizeBlockedSenderInput("   ")).toBeNull();
  });

  it("rejects invalid emails", () => {
    expect(normalizeBlockedSenderInput("a@b@c.com")).toBeNull();
    expect(normalizeBlockedSenderInput("@")).toBeNull();
    expect(normalizeBlockedSenderInput("user@")).toBeNull();
    expect(normalizeBlockedSenderInput("user@nodot")).toBeNull();
    expect(normalizeBlockedSenderInput(`u@${"a".repeat(320)}.com`)).toBeNull();
  });
});

describe("decodeBlockedSenders", () => {
  it("defaults to empty lists for missing or garbage input", () => {
    expect(decodeBlockedSenders(undefined)).toEqual(defaultBlockedSenders);
    expect(decodeBlockedSenders(null)).toEqual(defaultBlockedSenders);
    expect(decodeBlockedSenders("junk")).toEqual(defaultBlockedSenders);
    expect(decodeBlockedSenders(42)).toEqual(defaultBlockedSenders);
    expect(decodeBlockedSenders({ emails: "nope" })).toEqual(
      defaultBlockedSenders,
    );
  });

  it("keeps valid entries and drops non-string garbage", () => {
    expect(
      decodeBlockedSenders({
        emails: ["a@b.com", 42, null, "  "],
        domains: ["spam.co", {}, ""],
      }),
    ).toEqual({ emails: ["a@b.com"], domains: ["spam.co"] });
  });

  it("exposes a sane per-list cap", () => {
    expect(BLOCKED_SENDERS_MAX).toBe(500);
  });
});
