import { describe, expect, it } from "vitest";

import type { ShopifyCustomer } from "@support-agent/agent-core";

import {
  customerStats,
  formatMoneyAmount,
} from "../lib/customer-panel-data";

describe("formatMoneyAmount", () => {
  it("drops a whole `.00` tail and adds thousands separators", () => {
    expect(formatMoneyAmount("1240.00")).toBe("1,240");
    expect(formatMoneyAmount("1000000")).toBe("1,000,000");
    expect(formatMoneyAmount("0.00")).toBe("0");
  });

  it("keeps real cents", () => {
    expect(formatMoneyAmount("12.50")).toBe("12.50");
    expect(formatMoneyAmount("1240.99")).toBe("1,240.99");
  });

  it("returns the raw string when it isn't a finite number", () => {
    expect(formatMoneyAmount("abc")).toBe("abc");
    expect(formatMoneyAmount("")).toBe("");
  });
});

const customer = (
  overrides: Partial<ShopifyCustomer> = {},
): ShopifyCustomer => ({
  id: "gid://shopify/Customer/1" as ShopifyCustomer["id"],
  email: "jo@example.com",
  firstName: "Jo",
  lastName: "Lin",
  phone: null,
  ordersCount: 12,
  totalSpent: { amount: "1240.00", currencyCode: "USD" },
  defaultAddress: null,
  createdAt: new Date("2021-03-04T10:00:00.000Z"),
  ...overrides,
});

describe("customerStats", () => {
  it("builds the lifetime / orders / since triplet", () => {
    const stats = customerStats(customer());
    expect(stats.map((s) => s.label)).toEqual(["Lifetime", "Orders", "Since"]);
    expect(stats[0]).toMatchObject({ value: "1,240", hint: "USD" });
    expect(stats[1]).toMatchObject({ value: "12", hint: null });
    expect(stats[2]).toMatchObject({ value: "2021", hint: null });
  });

  it("derives the since-year from the ISO string the JSON wire delivers", () => {
    // Path B delivers `createdAt` as a string, not a Date — coerce, don't crash.
    const asWire = customer({
      createdAt: "2019-11-30T23:00:00.000Z" as unknown as Date,
    });
    expect(customerStats(asWire)[2]!.value).toBe("2019");
  });
});
