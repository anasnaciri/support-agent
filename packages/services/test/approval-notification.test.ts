import { describe, expect, it } from "vitest";
import { ApprovalId, TicketId, TenantId } from "@support-agent/agent-core";
import {
  buildApprovalNotification,
  verifyApprovalToken,
} from "@support-agent/services";

const linkConfig = {
  baseUrl: "https://api.example.com",
  signingKey: "test-signing-key",
  ttlMs: 30 * 24 * 60 * 60 * 1000,
};

const base = {
  approvalId: ApprovalId("11111111-1111-1111-1111-111111111111"),
  tenantId: TenantId("tenant-1"),
  ticketId: TicketId("ticket-1"),
  tool: "conversation.reply",
  linkConfig,
};

describe("buildApprovalNotification", () => {
  it("mints action-bound, verifiable approve/reject URLs", () => {
    const n = buildApprovalNotification({
      ...base,
      proposedInput: { subject: "Re: order", bodyText: "Hi there" },
    });

    expect(n.approveUrl).toContain(
      `/approvals/${base.approvalId}/approve?token=`,
    );
    expect(n.rejectUrl).toContain(`/approvals/${base.approvalId}/reject?token=`);

    const approveToken = decodeURIComponent(
      n.approveUrl.split("token=")[1] ?? "",
    );
    const verified = verifyApprovalToken({
      token: approveToken,
      secret: linkConfig.signingKey,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.approvalId).toBe(base.approvalId);
      expect(verified.action).toBe("approve");
    }
  });

  it("does not verify the approve token against the reject action (S3)", () => {
    const n = buildApprovalNotification({
      ...base,
      proposedInput: { bodyText: "Hi" },
    });
    const rejectToken = decodeURIComponent(
      n.rejectUrl.split("token=")[1] ?? "",
    );
    const verified = verifyApprovalToken({
      token: rejectToken,
      secret: linkConfig.signingKey,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.action).toBe("reject");
  });

  it("derives subject + preview from the draft for both payloads", () => {
    const n = buildApprovalNotification({
      ...base,
      proposedInput: { subject: "Re: your order", bodyText: "We refunded you." },
    });
    expect(n.draftSubject).toBe("Re: your order");
    expect(n.draftPreview).toBe("We refunded you.");
    expect(n.mail.toolName).toBe("conversation.reply");
    expect(n.mail.draftSubject).toBe("Re: your order");
    expect(n.mail.approveUrl).toBe(n.approveUrl);
    expect(n.merchant.kind).toBe("approval_requested");
    expect(n.merchant.body).toContain(n.approveUrl);
    expect(n.merchant.body).toContain(n.rejectUrl);
  });
});
