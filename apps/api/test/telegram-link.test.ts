import { describe, expect, it } from "vitest";
import {
  TELEGRAM_LINK_TTL_MS,
  mintTelegramLinkToken,
  verifyTelegramLinkToken,
} from "../src/telegram-link.js";

// The /start deep-link payload is the ONLY authorization on the Telegram
// linking webhook: whoever presents a valid token binds their chat to
// that tenant. So it must be signed, short-lived, and fit Telegram's
// start-parameter constraints (≤64 chars of [A-Za-z0-9_-]).

const key = "test-signing-key";
const tenantId = "11111111-2222-3333-4444-555555555555";
const now = Date.parse("2026-06-12T12:00:00.000Z");

describe("telegram link token", () => {
  it("round-trips a tenant id", () => {
    const token = mintTelegramLinkToken(key, tenantId, now + TELEGRAM_LINK_TTL_MS);
    const verified = verifyTelegramLinkToken(key, token, now);
    expect(verified).toEqual({ tenantId });
  });

  it("fits Telegram's start-parameter constraints", () => {
    const token = mintTelegramLinkToken(key, tenantId, now + TELEGRAM_LINK_TTL_MS);
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects an expired token", () => {
    const token = mintTelegramLinkToken(key, tenantId, now - 1);
    expect(verifyTelegramLinkToken(key, token, now)).toBeNull();
  });

  it("rejects a tampered token", () => {
    const token = mintTelegramLinkToken(key, tenantId, now + TELEGRAM_LINK_TTL_MS);
    const tampered =
      token.slice(0, 10) + (token[10] === "A" ? "B" : "A") + token.slice(11);
    expect(verifyTelegramLinkToken(key, tampered, now)).toBeNull();
  });

  it("rejects a token signed with a different key", () => {
    const token = mintTelegramLinkToken("other-key", tenantId, now + 60_000);
    expect(verifyTelegramLinkToken(key, token, now)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyTelegramLinkToken(key, "", now)).toBeNull();
    expect(verifyTelegramLinkToken(key, "abc", now)).toBeNull();
    expect(verifyTelegramLinkToken(key, "!".repeat(54), now)).toBeNull();
  });

  it("refuses to mint for a non-uuid tenant id", () => {
    expect(() => mintTelegramLinkToken(key, "not-a-uuid", now + 60_000)).toThrow();
  });
});
