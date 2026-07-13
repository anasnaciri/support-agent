import { describe, expect, it } from "vitest";

import {
  approvalStatusLabel,
  auditActionLabel,
  ticketStatusLabel,
  ticketSubjectLabel,
  hasSubject,
  humanizeSlug,
  toolActionLabel,
} from "../lib/labels";

// Merchant-facing label maps: raw enums / dotted tool ids / audit action
// codes must never surface in the UI. Every map humanizes unknown values so
// a newly-added backend code still renders as words, not snake_case.

describe("humanizeSlug", () => {
  it("de-snakes and capitalizes", () => {
    expect(humanizeSlug("where_is_order")).toBe("Where is order");
  });

  it("also splits dotted segments", () => {
    expect(humanizeSlug("ticket.escalated_to_human")).toBe(
      "Ticket escalated to human",
    );
  });
});

describe("ticketStatusLabel", () => {
  it("maps every runtime ticket status to merchant-friendly copy", () => {
    const statuses = [
      "new",
      "triaging",
      "in_progress",
      "waiting_for_customer",
      "waiting_for_fulfillment_operator",
      "waiting_for_approval",
      "approved_action_running",
      "resolved",
      "archived",
      "failed",
      "human_takeover",
    ];
    for (const status of statuses) {
      const label = ticketStatusLabel(status);
      expect(label, status).not.toMatch(/_/);
      expect(label[0], status).toBe(label[0]?.toUpperCase());
    }
  });

  it("never shows the human_takeover enum to a merchant", () => {
    expect(ticketStatusLabel("human_takeover")).toBe("With you");
    expect(ticketStatusLabel("waiting_for_approval")).toBe("Needs approval");
  });

  it("humanizes unknown statuses instead of leaking snake_case", () => {
    expect(ticketStatusLabel("some_future_status")).toBe("Some future status");
  });
});

describe("ticketSubjectLabel", () => {
  it("returns a real subject, trimmed of surrounding whitespace", () => {
    expect(ticketSubjectLabel("Refund for order #1024")).toBe(
      "Refund for order #1024",
    );
    expect(ticketSubjectLabel("  Order question  ")).toBe("Order question");
  });

  it("falls back when the subject is missing or only whitespace", () => {
    // `?? "(no subject)"` only caught null/undefined; an empty or
    // whitespace-only Subject header slipped through and rendered blank.
    expect(ticketSubjectLabel(null)).toBe("(No subject)");
    expect(ticketSubjectLabel(undefined)).toBe("(No subject)");
    expect(ticketSubjectLabel("")).toBe("(No subject)");
    expect(ticketSubjectLabel("   ")).toBe("(No subject)");
  });
});

describe("hasSubject", () => {
  it("is true only when there is non-whitespace content", () => {
    expect(hasSubject("Hello")).toBe(true);
    expect(hasSubject(null)).toBe(false);
    expect(hasSubject(undefined)).toBe(false);
    expect(hasSubject("")).toBe(false);
    expect(hasSubject("   ")).toBe(false);
  });
});

describe("approvalStatusLabel", () => {
  it("capitalizes the known statuses", () => {
    expect(approvalStatusLabel("pending")).toBe("Pending");
    expect(approvalStatusLabel("approved")).toBe("Approved");
    expect(approvalStatusLabel("rejected")).toBe("Rejected");
    expect(approvalStatusLabel("expired")).toBe("Expired");
  });

  it("humanizes unknown statuses", () => {
    expect(approvalStatusLabel("timed_out")).toBe("Timed out");
  });
});

describe("toolActionLabel", () => {
  it("names the approval-gated actions the way the catalog does", () => {
    expect(toolActionLabel("conversation.reply")).toBe("Send customer reply");
    expect(toolActionLabel("refund.create")).toBe("Issue a refund");
    expect(toolActionLabel("fulfillment_operator.add_sheet_row")).toBe(
      "Escalate to fulfillment partner",
    );
  });

  it("humanizes the tool's last segment as a fallback", () => {
    expect(toolActionLabel("shopify.get_order")).toBe("Get order");
  });
});

describe("auditActionLabel", () => {
  it("maps the common audit action codes", () => {
    expect(auditActionLabel("tool.invoked")).toBe("Action taken");
    expect(auditActionLabel("llm.decision")).toBe("Agent decision");
    expect(auditActionLabel("event.received")).toBe("Message received");
    expect(auditActionLabel("ticket.escalated_to_human")).toBe(
      "Escalated to you",
    );
  });

  it("groups compliance webhooks under one friendly label", () => {
    expect(auditActionLabel("compliance.customers_redact")).toBe(
      "Data & privacy request",
    );
  });

  it("humanizes unknown action codes", () => {
    expect(auditActionLabel("ticket.future_thing_happened")).toBe(
      "Ticket future thing happened",
    );
  });
});
