import { describe, expect, it } from "vitest";
import { deterministicReplyMessageId } from "../src/conversation.js";

// H8 — retry-safe send. A connector stamps this deterministic Message-ID on an
// outbound reply and, before re-sending after a crash/redelivery, scans the
// thread for it. The id MUST be a pure function of (mailbox, draftId) so the
// same reply always maps to the same id across deliveries, and DISTINCT drafts
// must never collide (a collision would suppress a legitimate different send).

describe("deterministicReplyMessageId", () => {
  it("is stable for the same (mailbox, draftId)", () => {
    const a = deterministicReplyMessageId("support@merchant.com", "draft-1");
    const b = deterministicReplyMessageId("support@merchant.com", "draft-1");
    expect(a).toBe(b);
  });

  it("embeds the mailbox domain and carries no angle brackets", () => {
    const id = deterministicReplyMessageId("support@merchant.com", "draft-1");
    expect(id.endsWith("@merchant.com")).toBe(true);
    expect(id).not.toContain("<");
    expect(id).not.toContain(">");
  });

  it("differs for distinct draft ids, even ones that sanitise alike", () => {
    const a = deterministicReplyMessageId("support@merchant.com", "a/b");
    const b = deterministicReplyMessageId("support@merchant.com", "a-b");
    expect(a).not.toBe(b);
  });

  it("differs across mailboxes for the same draft id", () => {
    const a = deterministicReplyMessageId("one@merchant.com", "draft-1");
    const b = deterministicReplyMessageId("two@other.com", "draft-1");
    expect(a).not.toBe(b);
  });

  it("falls back to a fixed domain when the mailbox has no @", () => {
    const id = deterministicReplyMessageId("not-an-email", "draft-1");
    expect(id).toContain("@");
    expect(id).not.toContain("<");
  });
});
