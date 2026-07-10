import { describe, expect, it } from "vitest";

import {
  approvalDecisionFeedback,
  bundleDecisionFeedback,
  ticketActionFeedback,
} from "../lib/ticket-action-feedback.js";

describe("ticketActionFeedback", () => {
  it("maps known outcomes to the right tone + copy", () => {
    expect(ticketActionFeedback("takeover", "taken_over").tone).toBe("success");
    expect(ticketActionFeedback("resolve", "resolved")).toEqual({
      tone: "success",
      text: "Ticket resolved.",
    });
    expect(ticketActionFeedback("setStatus", "transition_not_allowed").tone).toBe(
      "warning",
    );
    expect(ticketActionFeedback("resume", "not_in_takeover").tone).toBe("info");
    expect(ticketActionFeedback("resendApproval", "resent").tone).toBe("success");
    expect(ticketActionFeedback("resendApproval", "nothing_to_resend").tone).toBe(
      "info",
    );
    expect(ticketActionFeedback("escalateSupplier", "escalated").tone).toBe(
      "success",
    );
    expect(ticketActionFeedback("escalateSupplier", "no_supplier").tone).toBe(
      "warning",
    );
    expect(
      ticketActionFeedback("escalateSupplier", "already_escalated").tone,
    ).toBe("info");
  });

  it("maps every cancelOrder outcome, and never claims a refund on failure", () => {
    expect(ticketActionFeedback("cancelOrder", "cancelled").tone).toBe(
      "success",
    );
    expect(ticketActionFeedback("cancelOrder", "already_cancelled").tone).toBe(
      "info",
    );
    expect(ticketActionFeedback("cancelOrder", "order_not_found").tone).toBe(
      "warning",
    );
    expect(ticketActionFeedback("cancelOrder", "invalid_reason").tone).toBe(
      "warning",
    );

    // Shopify refused: the money did NOT move, and the copy must say so
    // rather than leaving the operator thinking the customer was repaid.
    const failed = ticketActionFeedback("cancelOrder", "cancel_failed");
    expect(failed.tone).toBe("warning");
    expect(failed.text).toContain("Nothing was cancelled");
  });

  it("falls back to a generic warning for an unknown/error kind", () => {
    expect(ticketActionFeedback("takeover", "error").tone).toBe("warning");
    expect(ticketActionFeedback("issueRefund", "nonsense")).toEqual({
      tone: "warning",
      text: "Something went wrong. Please try again.",
    });
  });
});

describe("approvalDecisionFeedback", () => {
  it("distinguishes approve vs reject success copy", () => {
    expect(approvalDecisionFeedback("approve", "decided").text).toMatch(
      /will be sent/,
    );
    expect(approvalDecisionFeedback("reject", "decided").text).toMatch(
      /human takeover/,
    );
  });

  it("shares the info/warning outcomes and a generic fallback", () => {
    expect(approvalDecisionFeedback("approve", "already_decided").tone).toBe(
      "info",
    );
    expect(approvalDecisionFeedback("reject", "approval_not_found").tone).toBe(
      "warning",
    );
    expect(approvalDecisionFeedback("approve", "boom").tone).toBe("warning");
  });
});

describe("bundleDecisionFeedback", () => {
  it("counts approved actions and describes a reject", () => {
    expect(bundleDecisionFeedback("approve", "decided", 3).text).toMatch(
      /Approved 3 actions/,
    );
    expect(bundleDecisionFeedback("approve", "decided", 1).text).toMatch(
      /Approved 1 action —/,
    );
    expect(bundleDecisionFeedback("reject", "decided", 2).text).toMatch(
      /Rejected the remaining/,
    );
  });

  it("treats no_pending as an info no-op and unknown as a generic error", () => {
    expect(bundleDecisionFeedback("approve", "no_pending").tone).toBe("info");
    expect(bundleDecisionFeedback("approve", "boom").tone).toBe("warning");
  });
});
