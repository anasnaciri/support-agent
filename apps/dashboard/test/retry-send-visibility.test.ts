import { describe, expect, it } from "vitest";
import { shouldShowRetrySendAction } from "../app/tickets/[id]/retry-send-visibility";

describe("retry-send visibility", () => {
  it("shows retry-send when a human-takeover ticket has an active reply delivery", () => {
    expect(
      shouldShowRetrySendAction({
        ticketStatus: "human_takeover",
        activeReplyDelivery: {
          id: "delivery-1",
          ticketId: "ticket-1",
          status: "abandoned",
        },
        riskFlags: [],
      }),
    ).toBe(true);
  });

  it("does not show retry-send from the legacy risk flag alone", () => {
    expect(
      shouldShowRetrySendAction({
        ticketStatus: "human_takeover",
        activeReplyDelivery: null,
        riskFlags: ["reply_delivery_failed"],
      }),
    ).toBe(false);
  });
});
