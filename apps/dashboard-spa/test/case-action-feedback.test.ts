import { describe, expect, it } from "vitest";

import {
  approvalDecisionFeedback,
  caseActionFeedback,
} from "../lib/case-action-feedback.js";

describe("caseActionFeedback", () => {
  it("maps known outcomes to the right tone + copy", () => {
    expect(caseActionFeedback("takeover", "taken_over").tone).toBe("success");
    expect(caseActionFeedback("resolve", "resolved")).toEqual({
      tone: "success",
      text: "Case resolved.",
    });
    expect(caseActionFeedback("setStatus", "transition_not_allowed").tone).toBe(
      "warning",
    );
    expect(caseActionFeedback("resume", "not_in_takeover").tone).toBe("info");
  });

  it("falls back to a generic warning for an unknown/error kind", () => {
    expect(caseActionFeedback("takeover", "error").tone).toBe("warning");
    expect(caseActionFeedback("issueRefund", "nonsense")).toEqual({
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
