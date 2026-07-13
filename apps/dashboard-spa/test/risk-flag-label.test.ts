import { describe, expect, it } from "vitest";
import { buildRiskFlagBadges, riskFlagLabel } from "../lib/risk-flag-label";

describe("riskFlagLabel", () => {
  it("humanises the duplicate-photo guard flag", () => {
    expect(riskFlagLabel("duplicate_photo_seen_in_ticket_abc")).toBe(
      "Duplicate photo seen on another ticket",
    );
  });

  it("humanises the refund customer-mismatch guard flag", () => {
    expect(riskFlagLabel("refund_customer_mismatch")).toBe(
      "Refund order belongs to a different customer",
    );
  });

  it("humanises unknown flags instead of leaking snake_case", () => {
    expect(riskFlagLabel("some_future_flag")).toBe("Some future flag");
  });

  it("humanises the failed-reply-delivery flag", () => {
    expect(riskFlagLabel("reply_delivery_failed")).toBe(
      "Reply didn't send: delivery failed",
    );
  });

  it("humanises the fulfillment partner-unreachable flag", () => {
    expect(riskFlagLabel("fulfillment_operator_unreachable")).toBe(
      "Fulfillment partner could not be reached",
    );
  });

  it("humanises the tracking-destination-mismatch guard flag", () => {
    expect(riskFlagLabel("tracking_destination_mismatch")).toBe(
      "Tracking may belong to a different order",
    );
  });

  it("distinguishes unavailable tracking destinations from mismatches", () => {
    expect(riskFlagLabel("tracking_destination_unavailable")).toBe(
      "Tracking destination could not be verified",
    );
  });

  it("humanises a failed live-tracking lookup", () => {
    expect(riskFlagLabel("tracking_lookup_failed")).toBe(
      "Live tracking lookup failed",
    );
  });
});

describe("buildRiskFlagBadges", () => {
  it("maps a non-duplicate flag 1:1 through riskFlagLabel", () => {
    expect(buildRiskFlagBadges(["refund_customer_mismatch"])).toEqual([
      { text: "Refund order belongs to a different customer" },
    ]);
  });

  it("names the single ticket for one duplicate-photo flag", () => {
    expect(
      buildRiskFlagBadges(["duplicate_photo_seen_in_ticket_abc"]),
    ).toEqual([
      { text: "Duplicate photo seen on ticket", ticketIds: ["abc"] },
    ]);
  });

  it("collapses many duplicate-photo flags into one counted chip carrying every id", () => {
    expect(
      buildRiskFlagBadges([
        "duplicate_photo_seen_in_ticket_abc",
        "duplicate_photo_seen_in_ticket_def",
        "duplicate_photo_seen_in_ticket_ghi",
      ]),
    ).toEqual([
      {
        text: "Duplicate photo seen in 3 tickets",
        ticketIds: ["abc", "def", "ghi"],
      },
    ]);
  });

  it("keeps the merged duplicate chip in the position of its first flag, other flags 1:1", () => {
    expect(
      buildRiskFlagBadges([
        "refund_customer_mismatch",
        "duplicate_photo_seen_in_ticket_abc",
        "fulfillment_operator_unreachable",
        "duplicate_photo_seen_in_ticket_def",
      ]),
    ).toEqual([
      { text: "Refund order belongs to a different customer" },
      {
        text: "Duplicate photo seen in 2 tickets",
        ticketIds: ["abc", "def"],
      },
      { text: "Fulfillment partner could not be reached" },
    ]);
  });

  it("falls back to a generic chip when the duplicate flag carries no id", () => {
    expect(buildRiskFlagBadges(["duplicate_photo_seen_in_ticket_"])).toEqual([
      { text: "Duplicate photo seen on another ticket" },
    ]);
  });

  it("counts and links DISTINCT tickets, collapsing a repeated ticket id", () => {
    expect(
      buildRiskFlagBadges([
        "duplicate_photo_seen_in_ticket_abc",
        "duplicate_photo_seen_in_ticket_abc",
        "duplicate_photo_seen_in_ticket_def",
      ]),
    ).toEqual([
      {
        text: "Duplicate photo seen in 2 tickets",
        ticketIds: ["abc", "def"],
      },
    ]);
  });

  it("renders a single chip when a repeated id leaves just one distinct ticket", () => {
    expect(
      buildRiskFlagBadges([
        "duplicate_photo_seen_in_ticket_abc",
        "duplicate_photo_seen_in_ticket_abc",
      ]),
    ).toEqual([{ text: "Duplicate photo seen on ticket", ticketIds: ["abc"] }]);
  });

  it("de-duplicates a repeated non-photo flag", () => {
    expect(
      buildRiskFlagBadges([
        "refund_customer_mismatch",
        "refund_customer_mismatch",
      ]),
    ).toEqual([{ text: "Refund order belongs to a different customer" }]);
  });
});
