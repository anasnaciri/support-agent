import { describe, expect, it } from "vitest";
import {
  signApprovalToken,
  signBundleReviewToken,
  verifyApprovalToken,
  verifyBundleReviewToken,
} from "../src/approval-tokens.js";

describe("approval tokens", () => {
  const SECRET = "test-signing-secret-do-not-use-in-prod";
  const NOW = 1_700_000_000_000;

  it("round-trips a valid token", () => {
    const token = signApprovalToken({
      approvalId: "appr-abc",
      action: "approve",
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
      expect(result.action).toBe("approve");
      expect(result.expiresAt).toBe(NOW + 60_000);
    }
  });

  it("binds the action into the signature (audit S3)", () => {
    // A reject link must not be usable to approve by editing the URL
    // path — the action travels inside the HMAC body, so the endpoint
    // compares the token's action against the path's action.
    const rejectToken = signApprovalToken({
      approvalId: "appr-1",
      action: "reject",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    const verified = verifyApprovalToken({
      token: rejectToken,
      secret: SECRET,
      nowMs: NOW + 1_000,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.action).toBe("reject");
    }
    // Tampering the action inside the token invalidates the signature.
    const parts = rejectToken.split(".");
    const tampered = `${parts[0]}.approve.${parts[2]}.${parts[3]}`;
    expect(
      verifyApprovalToken({ token: tampered, secret: SECRET, nowMs: NOW }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("defaults the link TTL to 30 days (the bearer link is the only expiring part)", () => {
    const token = signApprovalToken({
      approvalId: "appr-ttl",
      action: "approve",
      secret: SECRET,
      nowMs: NOW,
    });
    const result = verifyApprovalToken({
      token,
      secret: SECRET,
      nowMs: NOW + 1_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiresAt).toBe(NOW + 30 * 24 * 60 * 60 * 1000);
    }
  });

  it("rejects an expired token", () => {
    const token = signApprovalToken({
      approvalId: "appr-1",
      action: "approve",
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
      action: "approve",
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
      action: "approve",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    // Replace the approval id but keep the original signature.
    const parts = token.split(".");
    const tampered = `appr-tampered.${parts[1]}.${parts[2]}.${parts[3]}`;
    const result = verifyApprovalToken({
      token: tampered,
      secret: SECRET,
      nowMs: NOW + 1_000,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects malformed and legacy-format tokens", () => {
    for (const bad of [
      "not-a-token",
      "only.two",
      "...",
      "appr.approve.notanumber.sig",
      "appr.approve.-1.sig",
      // Legacy 3-part token (no action) must not verify.
      "appr-1.1700000060000.c2ln",
      // Unknown action.
      "appr.destroy.1700000060000.c2ln",
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
        action: i % 2 === 0 ? "approve" : "reject",
        secret: SECRET,
        ttlMs: 60_000,
        nowMs: NOW + i,
      });
      expect(token).not.toMatch(/[+/=]/u);
    }
  });
});

describe("bundle review tokens", () => {
  const SECRET = "test-signing-secret-do-not-use-in-prod";
  const NOW = 1_700_000_000_000;

  it("round-trips a valid token", () => {
    const token = signBundleReviewToken({
      ticketId: "ticket-abc",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    const result = verifyBundleReviewToken({
      token,
      secret: SECRET,
      nowMs: NOW + 1_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ticketId).toBe("ticket-abc");
      expect(result.expiresAt).toBe(NOW + 60_000);
    }
  });

  it("rejects an expired token", () => {
    const token = signBundleReviewToken({
      ticketId: "ticket-abc",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    const result = verifyBundleReviewToken({
      token,
      secret: SECRET,
      nowMs: NOW + 60_001,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a tampered signature", () => {
    const token = signBundleReviewToken({
      ticketId: "ticket-abc",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    const result = verifyBundleReviewToken({
      token: token.slice(0, -2) + "xx",
      secret: SECRET,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it("does not verify a single-approval token as a bundle review token", () => {
    // Cross-surface replay: an approve link's token must not open the
    // bundle review page for a ticket.
    const token = signApprovalToken({
      approvalId: "ticket-abc",
      action: "approve",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    const result = verifyBundleReviewToken({
      token,
      secret: SECRET,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it("does not verify a bundle review token as a single-approval token", () => {
    // Reverse direction: the review link must not decide a single
    // approval whose id happens to equal the ticket id.
    const token = signBundleReviewToken({
      ticketId: "ticket-abc",
      secret: SECRET,
      ttlMs: 60_000,
      nowMs: NOW,
    });
    const result = verifyApprovalToken({
      token,
      secret: SECRET,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it("emits URL-safe tokens", () => {
    for (let i = 0; i < 30; i++) {
      const token = signBundleReviewToken({
        ticketId: `ticket-${i}-${"x".repeat(i)}`,
        secret: SECRET,
        ttlMs: 60_000,
        nowMs: NOW + i,
      });
      expect(token).not.toMatch(/[+/=]/u);
    }
  });
});
