import { describe, expect, it } from "vitest";
import { refundCustomerMismatchFlag } from "../src/agent-runtime.js";

const seen = (entries: Record<string, string | null>) =>
  new Map(Object.entries(entries));

describe("refundCustomerMismatchFlag", () => {
  const input = { orderId: "gid://shopify/Order/1", amount: { amount: "5", currencyCode: "USD" } };

  it("flags a refund whose order customer differs from the case customer", () => {
    const flag = refundCustomerMismatchFlag(
      input,
      { customerEmail: "jane@example.com" },
      seen({ "gid://shopify/Order/1": "attacker@evil.com" }),
    );
    expect(flag).toBe("refund_customer_mismatch");
  });

  it("does not flag when the emails match (case-insensitive, trimmed)", () => {
    const flag = refundCustomerMismatchFlag(
      input,
      { customerEmail: "Jane@Example.com " },
      seen({ "gid://shopify/Order/1": " jane@example.com" }),
    );
    expect(flag).toBeNull();
  });

  it("does not flag when the case has no known customer email", () => {
    const flag = refundCustomerMismatchFlag(
      input,
      {},
      seen({ "gid://shopify/Order/1": "attacker@evil.com" }),
    );
    expect(flag).toBeNull();
  });

  it("does not flag when the order was not looked up this tick (fail open)", () => {
    const flag = refundCustomerMismatchFlag(
      input,
      { customerEmail: "jane@example.com" },
      seen({}),
    );
    expect(flag).toBeNull();
  });

  it("does not flag when the looked-up order has no customer email", () => {
    const flag = refundCustomerMismatchFlag(
      input,
      { customerEmail: "jane@example.com" },
      seen({ "gid://shopify/Order/1": null }),
    );
    expect(flag).toBeNull();
  });

  it("returns null for non-refund-shaped input", () => {
    expect(
      refundCustomerMismatchFlag(
        { somethingElse: true },
        { customerEmail: "jane@example.com" },
        seen({ "gid://shopify/Order/1": "attacker@evil.com" }),
      ),
    ).toBeNull();
    expect(
      refundCustomerMismatchFlag(
        null,
        { customerEmail: "jane@example.com" },
        seen({}),
      ),
    ).toBeNull();
  });
});
