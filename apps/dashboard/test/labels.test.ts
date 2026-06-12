import { describe, expect, it } from "vitest";

import {
  approvalStatusLabel,
  auditActionLabel,
  caseStatusLabel,
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
    expect(humanizeSlug("case.escalated_to_human")).toBe(
      "Case escalated to human",
    );
  });
});

describe("caseStatusLabel", () => {
  it("maps every runtime case status to merchant-friendly copy", () => {
    const statuses = [
      "new",
      "triaging",
      "in_progress",
      "waiting_for_customer",
      "waiting_for_supplier",
      "waiting_for_approval",
      "approved_action_running",
      "resolved",
      "failed",
      "human_takeover",
    ];
    for (const status of statuses) {
      const label = caseStatusLabel(status);
      expect(label, status).not.toMatch(/_/);
      expect(label[0], status).toBe(label[0]?.toUpperCase());
    }
  });

  it("never shows the human_takeover enum to a merchant", () => {
    expect(caseStatusLabel("human_takeover")).toBe("With you");
    expect(caseStatusLabel("waiting_for_approval")).toBe("Needs approval");
  });

  it("humanizes unknown statuses instead of leaking snake_case", () => {
    expect(caseStatusLabel("some_future_status")).toBe("Some future status");
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
    expect(toolActionLabel("supplier.add_sheet_row")).toBe(
      "Escalate to supplier",
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
    expect(auditActionLabel("case.escalated_to_human")).toBe(
      "Escalated to you",
    );
  });

  it("groups compliance webhooks under one friendly label", () => {
    expect(auditActionLabel("compliance.customers_redact")).toBe(
      "Data & privacy request",
    );
  });

  it("humanizes unknown action codes", () => {
    expect(auditActionLabel("case.future_thing_happened")).toBe(
      "Case future thing happened",
    );
  });
});
