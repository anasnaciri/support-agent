import { describe, expect, it } from "vitest";

import { isTicketProcessing } from "../lib/ticket-processing";

// "Processing" = the agent is actively working the ticket right now. It powers
// the animated composer border and the status-chip shimmer on the ticket page,
// so it must cover exactly the machine-active statuses — not the parked ones.
describe("isTicketProcessing", () => {
  it("is true while the agent is actively working", () => {
    expect(isTicketProcessing("triaging")).toBe(true);
    expect(isTicketProcessing("in_progress")).toBe(true);
    expect(isTicketProcessing("approved_action_running")).toBe(true);
  });

  it("is false for parked, waiting, and terminal states", () => {
    expect(isTicketProcessing("new")).toBe(false);
    expect(isTicketProcessing("waiting_for_customer")).toBe(false);
    expect(isTicketProcessing("waiting_for_supplier")).toBe(false);
    expect(isTicketProcessing("waiting_for_approval")).toBe(false);
    expect(isTicketProcessing("human_takeover")).toBe(false);
    expect(isTicketProcessing("resolved")).toBe(false);
    expect(isTicketProcessing("archived")).toBe(false);
    expect(isTicketProcessing("failed")).toBe(false);
  });

  it("fails safe (no animation) on an unknown status", () => {
    expect(isTicketProcessing("nonsense")).toBe(false);
  });
});
