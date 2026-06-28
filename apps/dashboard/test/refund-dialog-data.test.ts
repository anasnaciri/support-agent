import { describe, expect, it } from "vitest";
import type { ShopifyRefundLineItem } from "@support-agent/agent-core";
import {
  buildRefundLineItems,
  clampQuantity,
  computeRefundTotals,
  defaultSelections,
  resolveRestockType,
  validateRefundAmount,
} from "../app/cases/[id]/refund-dialog-data";

const line = (
  over: Partial<ShopifyRefundLineItem> = {},
): ShopifyRefundLineItem => ({
  lineItemId: "gid://shopify/LineItem/1",
  title: "Snowboard",
  variantTitle: null,
  sku: "snow-1",
  imageUrl: null,
  refundableQuantity: 2,
  unitPrice: { amount: "300.00", currencyCode: "USD" },
  unitTax: { amount: "30.00", currencyCode: "USD" },
  restockable: true,
  fulfilled: true,
  restockLocationId: "gid://shopify/Location/5",
  ...over,
});

describe("defaultSelections", () => {
  it("selects full refundable quantity and pre-checks restock when restockable", () => {
    const sels = defaultSelections([
      line(),
      line({ lineItemId: "L2", refundableQuantity: 1, restockable: false }),
    ]);
    expect(sels).toEqual({
      "gid://shopify/LineItem/1": { quantity: 2, restock: true },
      L2: { quantity: 1, restock: false },
    });
  });
});

describe("clampQuantity", () => {
  it("clamps into [0, max] and floors", () => {
    expect(clampQuantity(5, 2)).toBe(2);
    expect(clampQuantity(-1, 2)).toBe(0);
    expect(clampQuantity(1.9, 3)).toBe(1);
    expect(clampQuantity(Number.NaN, 3)).toBe(0);
  });
});

describe("computeRefundTotals", () => {
  it("sums unit price + tax across selected lines and adds shipping when checked", () => {
    const lineItems = [
      line(),
      line({
        lineItemId: "L2",
        unitPrice: { amount: "100.00", currencyCode: "USD" },
        unitTax: { amount: "0.00", currencyCode: "USD" },
        refundableQuantity: 1,
      }),
    ];
    const totals = computeRefundTotals({
      lineItems,
      selections: {
        "gid://shopify/LineItem/1": { quantity: 2, restock: true },
        L2: { quantity: 1, restock: false },
      },
      refundShipping: true,
      shippingRefundable: "9.99",
    });
    // items subtotal = 300*2 + 100*1 = 700; tax = 30*2 = 60; shipping = 9.99
    expect(totals.itemsSubtotal).toBeCloseTo(700, 5);
    expect(totals.itemsCount).toBe(3);
    expect(totals.tax).toBeCloseTo(60, 5);
    expect(totals.shipping).toBeCloseTo(9.99, 5);
    expect(totals.refundTotal).toBeCloseTo(769.99, 5);
  });

  it("excludes zero-quantity lines and omits shipping when unchecked", () => {
    const totals = computeRefundTotals({
      lineItems: [line()],
      selections: { "gid://shopify/LineItem/1": { quantity: 0, restock: true } },
      refundShipping: false,
      shippingRefundable: "9.99",
    });
    expect(totals.itemsSubtotal).toBe(0);
    expect(totals.itemsCount).toBe(0);
    expect(totals.refundTotal).toBe(0);
  });
});

describe("resolveRestockType", () => {
  it("maps fulfilled→RETURN, unfulfilled→CANCEL, unchecked→NO_RESTOCK", () => {
    expect(resolveRestockType(line({ fulfilled: true }), true)).toBe("RETURN");
    expect(resolveRestockType(line({ fulfilled: false }), true)).toBe("CANCEL");
    expect(resolveRestockType(line({ fulfilled: true }), false)).toBe(
      "NO_RESTOCK",
    );
  });
});

describe("buildRefundLineItems", () => {
  it("shapes the selection, forces restock off for non-restockable, drops zero-qty", () => {
    const lineItems = [
      line(), // restockable + fulfilled
      line({
        lineItemId: "L2",
        fulfilled: false,
        restockable: true,
        restockLocationId: "gid://shopify/Location/9",
      }),
      line({ lineItemId: "L3", restockable: false }),
      line({ lineItemId: "L4" }),
    ];
    const payload = buildRefundLineItems({
      lineItems,
      selections: {
        "gid://shopify/LineItem/1": { quantity: 2, restock: true },
        L2: { quantity: 1, restock: true },
        L3: { quantity: 1, restock: true }, // restock forced off (not restockable)
        L4: { quantity: 0, restock: true }, // dropped
      },
      locationId: null,
    });
    expect(payload).toEqual([
      {
        lineItemId: "gid://shopify/LineItem/1",
        quantity: 2,
        restockType: "RETURN",
        locationId: "gid://shopify/Location/5",
      },
      {
        lineItemId: "L2",
        quantity: 1,
        restockType: "CANCEL",
        locationId: "gid://shopify/Location/9",
      },
      {
        lineItemId: "L3",
        quantity: 1,
        restockType: "NO_RESTOCK",
        locationId: null,
      },
    ]);
  });

  it("prefers an explicitly chosen location over the line's default", () => {
    const payload = buildRefundLineItems({
      lineItems: [line()],
      selections: { "gid://shopify/LineItem/1": { quantity: 1, restock: true } },
      locationId: "gid://shopify/Location/99",
    });
    expect(payload[0]!.locationId).toBe("gid://shopify/Location/99");
  });
});

describe("validateRefundAmount", () => {
  it("accepts a positive amount within the maximum", () => {
    expect(validateRefundAmount("660.00", "660.00")).toEqual({
      ok: true,
      amount: "660.00",
    });
  });

  it("rejects empty, non-numeric, non-positive, and over-max", () => {
    expect(validateRefundAmount("", "660").ok).toBe(false);
    expect(validateRefundAmount("abc", "660").ok).toBe(false);
    expect(validateRefundAmount("0", "660").ok).toBe(false);
    expect(validateRefundAmount("700", "660")).toEqual({
      ok: false,
      reason: "exceeds_max",
    });
  });
});
