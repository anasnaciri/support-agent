import { describe, expect, it } from "vitest";
import type { OrderPiiPresence } from "@support-agent/services";
import { summarizeOrderPii } from "../src/admin-shopify-app.js";

const order = (over: Partial<OrderPiiPresence> = {}): OrderPiiPresence => ({
  orderName: "#1001",
  hasEmail: true,
  hasCustomerName: true,
  hasShippingAddress: true,
  ...over,
});

describe("summarizeOrderPii (PCD verdict)", () => {
  it("reports no_orders for an empty sample", () => {
    expect(summarizeOrderPii([])).toEqual({
      verdict: "no_orders",
      ordersChecked: 0,
      sawEmail: false,
      sawCustomerName: false,
      sawShippingAddress: false,
    });
  });

  it("reports present when any recent order returns customer email", () => {
    const out = summarizeOrderPii([
      order({ hasEmail: false, hasCustomerName: false, hasShippingAddress: false }),
      order({ hasEmail: true, hasCustomerName: true, hasShippingAddress: true }),
    ]);
    expect(out.verdict).toBe("present");
    expect(out.ordersChecked).toBe(2);
    expect(out.sawEmail).toBe(true);
    expect(out.sawCustomerName).toBe(true);
    expect(out.sawShippingAddress).toBe(true);
  });

  it("reports redacted when orders exist but none return email", () => {
    const out = summarizeOrderPii([
      order({ hasEmail: false, hasCustomerName: false, hasShippingAddress: false }),
      order({ hasEmail: false, hasCustomerName: false, hasShippingAddress: false }),
    ]);
    expect(out.verdict).toBe("redacted");
    expect(out.ordersChecked).toBe(2);
    expect(out.sawEmail).toBe(false);
  });

  it("anchors the verdict on email, not name/address (guest/digital orders)", () => {
    // Email present but name + address legitimately absent → still present.
    const out = summarizeOrderPii([
      order({ hasEmail: true, hasCustomerName: false, hasShippingAddress: false }),
    ]);
    expect(out.verdict).toBe("present");
    expect(out.sawCustomerName).toBe(false);
    expect(out.sawShippingAddress).toBe(false);
  });
});
