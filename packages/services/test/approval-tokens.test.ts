import { describe, expect, it } from "vitest";
import {
  signApprovalToken,
  verifyApprovalToken,
} from "../src/approval-tokens.js";

describe("approval tokens", () => {
  const SECRET = "test-signing-secret-do-not-use-in-prod";
  const NOW = 1_700_000_000_000;

  it("round-trips a valid token", () => {
    const token = signApprovalToken({
      approvalId: "appr-abc",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    const result = verifyApprovalToken({
      token,
      secret: SECRET,
      nowMs: NOW + 1_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approvalId).toBe("appr-abc");
      expect(result.expiresAt).toBe(NOW + 60_000);
    }
  });

  it("rejects an expired token", () => {
    const token = signApprovalToken({
      approvalId: "appr-1",
      secret: SECRET,
      ttlMs: 1_000,
      nowMs: NOW,
    });
    const result = verifyApprovalToken({
      token,
      secret: SECRET,
      nowMs: NOW + 5_000,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signApprovalToken({
      approvalId: "appr-1",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    const result = verifyApprovalToken({
      token,
      secret: "different-secret",
      nowMs: NOW + 1_000,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a token whose body has been tampered with", () => {
    const token = signApprovalToken({
      approvalId: "appr-original",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    // Replace the approval id but keep the original signature.
    const parts = token.split(".");
    const tampered = `appr-tampered.${parts[1]}.${parts[2]}`;
    const result = verifyApprovalToken({
      token: tampered,
      secret: SECRET,
      nowMs: NOW + 1_000,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects malformed tokens", () => {
    for (const bad of [
      "not-a-token",
      "only.two",
      "..",
      "appr.notanumber.sig",
      "appr.-1.sig",
    ]) {
      const result = verifyApprovalToken({
        token: bad,
        secret: SECRET,
        nowMs: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["malformed", "invalid_signature"]).toContain(result.reason);
      }
    }
  });

  it("emits URL-safe tokens (no '+', '/', '=' padding)", () => {
    // Sign 30 tokens with varied inputs to flush base64 edge cases.
    for (let i = 0; i < 30; i++) {
      const token = signApprovalToken({
        approvalId: `appr-${i}-${"x".repeat(i)}`,
        secret: SECRET,
        ttlMs: 60_000,
        nowMs: NOW + i,
      });
      expect(token).not.toMatch(/[+/=]/u);
    }
  });
});
