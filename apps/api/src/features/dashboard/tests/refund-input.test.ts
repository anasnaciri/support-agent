import { describe, expect, it } from "vitest";
import { parseRefundLineItems, parseRefundShipping } from "../refund-input.js";

describe("parseRefundLineItems", () => {
  it("keeps well-formed lines and strips locationId from NO_RESTOCK", () => {
    expect(
      parseRefundLineItems([
        {
          lineItemId: "gid://shopify/LineItem/1",
          quantity: 2,
          restockType: "RETURN",
          locationId: "gid://shopify/Location/5",
        },
        {
          lineItemId: "gid://shopify/LineItem/2",
          quantity: 1,
          restockType: "NO_RESTOCK",
          locationId: "gid://shopify/Location/5",
        },
      ]),
    ).toEqual([
      {
        lineItemId: "gid://shopify/LineItem/1",
        quantity: 2,
        restockType: "RETURN",
        locationId: "gid://shopify/Location/5",
      },
      {
        lineItemId: "gid://shopify/LineItem/2",
        quantity: 1,
        restockType: "NO_RESTOCK",
        locationId: null,
      },
    ]);
  });

  it("drops malformed entries (missing id, bad qty, unknown restockType)", () => {
    expect(
      parseRefundLineItems([
        { quantity: 1, restockType: "RETURN" }, // no id
        { lineItemId: "x", quantity: 0, restockType: "RETURN" }, // qty 0
        { lineItemId: "x", quantity: 1.5, restockType: "RETURN" }, // non-int
        { lineItemId: "x", quantity: 1, restockType: "MELT" }, // bad type
        "not-an-object",
        { lineItemId: "ok", quantity: 1, restockType: "CANCEL", locationId: "L1" },
      ]),
    ).toEqual([
      { lineItemId: "ok", quantity: 1, restockType: "CANCEL", locationId: "L1" },
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(parseRefundLineItems(undefined)).toEqual([]);
    expect(parseRefundLineItems({})).toEqual([]);
    expect(parseRefundLineItems(null)).toEqual([]);
  });
});

describe("parseRefundShipping", () => {
  it("parses a positive money object", () => {
    expect(parseRefundShipping({ amount: "4.99", currencyCode: "USD" })).toEqual({
      amount: "4.99",
      currencyCode: "USD",
    });
  });

  it("returns null for absent / malformed / non-positive shipping", () => {
    expect(parseRefundShipping(undefined)).toBeNull();
    expect(parseRefundShipping({ amount: "0", currencyCode: "USD" })).toBeNull();
    expect(parseRefundShipping({ amount: "x", currencyCode: "USD" })).toBeNull();
    expect(parseRefundShipping({ amount: "4.99" })).toBeNull();
  });
});
