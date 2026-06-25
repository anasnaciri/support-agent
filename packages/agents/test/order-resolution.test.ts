import { describe, expect, it } from "vitest";
import { ORDER_RESOLUTION_LINES } from "../src/order-resolution.js";

const text = ORDER_RESOLUTION_LINES.join("\n");

describe("ORDER_RESOLUTION_LINES (shared order-obtaining block)", () => {
  it("drives the first lookup from the customer's quoted ref, not the canonical pointer", () => {
    // Specialists start from `quotedOrderRef` (the untrusted hint triage
    // recorded). The canonical `identifiedOrderId` GID is runtime-owned and is
    // surfaced separately as the bound-order header — agents never key off it
    // by name.
    expect(text).toContain("quotedOrderRef");
    expect(text).not.toContain("identifiedOrderId");
  });

  it("loads an already-identified order by its GID instead of re-searching", () => {
    expect(text).toContain("already has an identified order");
    expect(text).toContain("shopify.get_order");
  });

  it("falls back to find_customer_order when the quoted ref does not resolve", () => {
    // The Susan bug: a mistyped / wrong confirmation code must not dead-end in
    // "I can't find your order" when the customer has a findable order.
    expect(text.toLowerCase()).toContain("not-found");
    expect(text).toContain("shopify.find_customer_order");
  });
});
