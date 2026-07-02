import { describe, expect, it } from "vitest";
import type { ApprovalDetail, AuditEntry } from "@support-agent/dashboard-contracts";
import { resurfaceableApprovedReply } from "../src/approved-not-sent.js";

// H9 — surface an "approved but not sent" reply. A conversation.reply approval
// that a manager approved AFTER the case was taken over is skipped by the
// runtime (audit `approval.stale_delivery_skipped`) and retired; the drafted
// reply never goes out. This pure helper picks the approval to resurface so the
// operator can one-click resend it.

const approval = (over: Partial<ApprovalDetail> = {}): ApprovalDetail => ({
  id: "appr-1",
  caseId: "case-1",
  agentId: "support-triage",
  tool: "conversation.reply",
  proposedInput: { draftId: "d-1", bodyText: "Your order shipped." },
  approvedInput: null,
  reasoning: null,
  riskLevel: "medium",
  status: "approved",
  decidedBy: "user-1",
  decidedAt: "2026-07-01T10:00:00.000Z",
  decisionReason: null,
  expiresAt: "2026-07-30T10:00:00.000Z",
  createdAt: "2026-07-01T09:00:00.000Z",
  ...over,
});

const skipEntry = (approvalId: string, id = "a-skip"): AuditEntry => ({
  id,
  caseId: "case-1",
  action: "approval.stale_delivery_skipped",
  actorType: "system",
  actorId: "runtime",
  occurredAt: "2026-07-01T10:01:00.000Z",
  details: { approvalId, status: "human_takeover" },
});

const resentEntry = (approvalId: string, id = "a-resent"): AuditEntry => ({
  id,
  caseId: "case-1",
  action: "case.approved_reply_resent",
  actorType: "user",
  actorId: "user-1",
  occurredAt: "2026-07-01T11:00:00.000Z",
  details: { approvalId },
});

describe("resurfaceableApprovedReply", () => {
  it("returns the approval that was approved, is a reply, and was skipped", () => {
    const a = approval();
    const got = resurfaceableApprovedReply([skipEntry(a.id)], [a]);
    expect(got?.id).toBe(a.id);
  });

  it("returns null once the approval has been resent", () => {
    const a = approval();
    const got = resurfaceableApprovedReply(
      [skipEntry(a.id), resentEntry(a.id)],
      [a],
    );
    expect(got).toBeNull();
  });

  it("returns null when the approval was never skipped", () => {
    const a = approval();
    expect(resurfaceableApprovedReply([], [a])).toBeNull();
  });

  it("ignores non-reply tools (e.g. refunds) even if skipped", () => {
    const a = approval({ tool: "refund.create" });
    expect(resurfaceableApprovedReply([skipEntry(a.id)], [a])).toBeNull();
  });

  it("ignores approvals that are not in `approved` status", () => {
    const a = approval({ status: "rejected" });
    expect(resurfaceableApprovedReply([skipEntry(a.id)], [a])).toBeNull();
  });

  it("returns the most recently created candidate when several qualify", () => {
    const older = approval({ id: "appr-old", createdAt: "2026-07-01T08:00:00.000Z" });
    const newer = approval({ id: "appr-new", createdAt: "2026-07-01T09:30:00.000Z" });
    const got = resurfaceableApprovedReply(
      [skipEntry(older.id, "s1"), skipEntry(newer.id, "s2")],
      [older, newer],
    );
    expect(got?.id).toBe("appr-new");
  });
});
