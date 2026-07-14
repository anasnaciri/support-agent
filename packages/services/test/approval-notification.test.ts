import { describe, expect, it } from "vitest";
import { ApprovalId, TicketId, TenantId } from "@support-agent/agent-core";
import {
  buildApprovalNotification,
  buildBundleApprovalNotification,
  verifyApprovalToken,
  verifyBundleReviewToken,
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
    expect(n.mail.toolName).toBe("Reply to the customer");
    expect(n.mail.draftSubject).toBe("Re: your order");
    expect(n.mail.approveUrl).toBe(n.approveUrl);
    expect(n.merchant.kind).toBe("approval_requested");
    expect(n.merchant.body).toContain(n.approveUrl);
    expect(n.merchant.body).toContain(n.rejectUrl);
  });

  it("labels reminders at the top and uses the tool display name", () => {
    const n = buildApprovalNotification({
      ...base,
      proposedInput: { bodyText: "Please review this reply." },
      reminder: true,
    });

    expect(n.mail.reminder).toBe(true);
    expect(n.mail.toolName).toBe("Reply to the customer");
    expect(n.merchant.title).toMatch(/^\[REMINDER\]/u);
    expect(n.merchant.body).toContain('"Reply to the customer"');
    expect(n.merchant.body).not.toContain('"conversation.reply"');
  });
});

describe("buildBundleApprovalNotification", () => {
  const bundleBase = {
    tenantId: TenantId("tenant-1"),
    ticketId: TicketId("ticket-1"),
    ticketSubject: "Where is my order?",
    customerEmail: "jane@example.com",
    actions: [
      {
        tool: "conversation.reply",
        proposedInput: { bodyText: "Hi Jane, here's an update." },
      },
      {
        tool: "refund.create",
        proposedInput: {
          orderId: "gid://shopify/Order/123",
          amount: { amount: "23.50", currencyCode: "EUR" },
        },
      },
    ],
    linkConfig,
  };

  it("mints a ticket-bound review URL that verifies as a bundle token", () => {
    const n = buildBundleApprovalNotification(bundleBase);
    expect(n.reviewUrl).toContain(
      `${linkConfig.baseUrl}/approvals/bundle/${bundleBase.ticketId}?token=`,
    );
    const token = decodeURIComponent(n.reviewUrl.split("token=")[1] ?? "");
    const verified = verifyBundleReviewToken({
      token,
      secret: linkConfig.signingKey,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.ticketId).toBe(bundleBase.ticketId);
    }
  });

  it("hands the merchant ping the per-action summaries and the review link", () => {
    const n = buildBundleApprovalNotification(bundleBase);
    expect(n.merchant.kind).toBe("approval_requested");
    expect(n.merchant.body).toContain("jane@example.com");
    expect(n.merchant.body).toContain("23.50 EUR");
    expect(n.merchant.body).toContain(n.reviewUrl);
  });

  it("honors the nowMs override for deterministic tokens", () => {
    const a = buildBundleApprovalNotification({ ...bundleBase, nowMs: 1000 });
    const b = buildBundleApprovalNotification({ ...bundleBase, nowMs: 1000 });
    expect(a.reviewUrl).toBe(b.reviewUrl);
  });
});
