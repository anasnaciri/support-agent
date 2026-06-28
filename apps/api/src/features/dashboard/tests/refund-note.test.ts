import { describe, expect, it } from "vitest";
import { dashboardRefundNote } from "../refund-note.js";

describe("dashboardRefundNote", () => {
  it("notes the case when no staff reason is given", () => {
    expect(dashboardRefundNote({ caseId: "case-1", reason: null })).toBe(
      "Refund issued from dashboard — case case-1",
    );
  });

  it("appends a staff reason when present", () => {
    expect(
      dashboardRefundNote({ caseId: "case-1", reason: "Damaged on arrival" }),
    ).toBe("Refund issued from dashboard — case case-1 — reason: Damaged on arrival");
  });

  it("trims surrounding whitespace and treats a blank reason as none", () => {
    expect(
      dashboardRefundNote({ caseId: "case-2", reason: "  late delivery  " }),
    ).toBe("Refund issued from dashboard — case case-2 — reason: late delivery");
    expect(dashboardRefundNote({ caseId: "case-2", reason: "   " })).toBe(
      "Refund issued from dashboard — case case-2",
    );
  });
});
