import { describe, expect, it } from "vitest";
import { approvedNotSentTimelineItem } from "../lib/ticket-timeline.js";

// H9 — the "approved but not sent" card. Mirrors the failed-delivery card: it's
// derived from the live TicketDetail.approvedNotSent (not an audit row) and shows
// only while a human is driving the ticket, so the card and its resend button
// share one condition.

const approvedNotSent = {
  approvalId: "appr-1",
  bodyPreview: "Your order shipped yesterday.",
  occurredAt: "2026-07-01T10:00:00.000Z",
};

describe("approvedNotSentTimelineItem", () => {
  it("returns a card when human_takeover and an approved reply is unsent", () => {
    const item = approvedNotSentTimelineItem({
      ticketStatus: "human_takeover",
      approvedNotSent,
    });
    expect(item).not.toBeNull();
    expect(item?.kind).toBe("approvedNotSent");
    if (item?.kind !== "approvedNotSent") return;
    expect(item.approvalId).toBe("appr-1");
    expect(item.bodyPreview).toBe("Your order shipped yesterday.");
    expect(item.occurredAt).toBe("2026-07-01T10:00:00.000Z");
  });

  it("returns null when there is nothing to resend", () => {
    expect(
      approvedNotSentTimelineItem({
        ticketStatus: "human_takeover",
        approvedNotSent: null,
      }),
    ).toBeNull();
  });

  it("returns null unless the ticket is under human_takeover", () => {
    for (const ticketStatus of ["in_progress", "resolved", "waiting_for_approval"]) {
      expect(
        approvedNotSentTimelineItem({ ticketStatus, approvedNotSent }),
      ).toBeNull();
    }
  });
});
