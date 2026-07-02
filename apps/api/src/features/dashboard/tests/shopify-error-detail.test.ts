import { describe, expect, it } from "vitest";
import {
  NetworkError,
  OrderNotFound,
  RefundFailed,
  ShopifyAuthFailed,
  ShopifyResponseInvalid,
} from "@support-agent/agent-core";
import { describeShopifyError } from "../shopify-error-detail.js";

describe("describeShopifyError", () => {
  it("preserves a ShopifyResponseInvalid's GraphQL message (the refund-502 case)", () => {
    const e = new ShopifyResponseInvalid({
      message: `Cannot query field "code" on type "UserError".`,
    });
    const s = describeShopifyError(e);
    expect(s).toContain("code");
    expect(s).toContain("UserError");
    // Must NOT collapse to the bare tag — that's the bug this fixes.
    expect(s).not.toBe("ShopifyResponseInvalid");
  });

  it("surfaces a NetworkError's underlying cause, not just the tag", () => {
    expect(describeShopifyError(new NetworkError({ cause: "Shopify HTTP 503: down" }))).toContain(
      "503",
    );
    expect(
      describeShopifyError(new NetworkError({ cause: new Error("socket hang up") })),
    ).toContain("socket hang up");
  });

  it("includes RefundFailed's message (and code when present)", () => {
    const s = describeShopifyError(
      new RefundFailed({ orderId: "gid://1", code: "TAXES", message: "no" }),
    );
    expect(s).toContain("TAXES");
    expect(s).toContain("no");
  });

  it("names the order for OrderNotFound and stays log-safe for auth", () => {
    expect(describeShopifyError(new OrderNotFound({ orderId: "gid://9" }))).toContain("gid://9");
    // Never throws; always returns a non-empty string.
    expect(
      describeShopifyError(new ShopifyAuthFailed({ tenantId: "t1" as never })).length,
    ).toBeGreaterThan(0);
  });
});
