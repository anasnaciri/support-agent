import { describe, expect, it } from "vitest";
import { dashboardRefundNote } from "../refund-note.js";

describe("dashboardRefundNote", () => {
  it("notes the ticket when no staff reason is given", () => {
    expect(dashboardRefundNote({ ticketId: "ticket-1", reason: null })).toBe(
      "Refund issued from dashboard — ticket ticket-1",
    );
  });

  it("appends a staff reason when present", () => {
    expect(
      dashboardRefundNote({ ticketId: "ticket-1", reason: "Damaged on arrival" }),
    ).toBe("Refund issued from dashboard — ticket ticket-1 — reason: Damaged on arrival");
  });

  it("trims surrounding whitespace and treats a blank reason as none", () => {
    expect(
      dashboardRefundNote({ ticketId: "ticket-2", reason: "  late delivery  " }),
    ).toBe("Refund issued from dashboard — ticket ticket-2 — reason: late delivery");
    expect(dashboardRefundNote({ ticketId: "ticket-2", reason: "   " })).toBe(
      "Refund issued from dashboard — ticket ticket-2",
    );
  });
});
