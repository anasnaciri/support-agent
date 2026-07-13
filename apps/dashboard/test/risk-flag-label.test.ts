import { describe, expect, it } from "vitest";
import { riskFlagLabel } from "../app/tickets/[id]/risk-flag-label";

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
      "Reply didn't send — delivery failed",
    );
  });

  it("humanises the fulfillment partner-unreachable flag", () => {
    expect(riskFlagLabel("fulfillment_operator_unreachable")).toBe(
      "Fulfillment partner could not be reached",
    );
  });
});
