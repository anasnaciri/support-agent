import { describe, expect, it } from "vitest";
import { isConnectorScopeGranted } from "../src/index.js";

describe("isConnectorScopeGranted", () => {
  it("matches a literal granted scope", () => {
    expect(isConnectorScopeGranted("gmail", "send", ["send", "read"])).toBe(
      true,
    );
    expect(isConnectorScopeGranted("gmail", "modify", ["send"])).toBe(false);
  });

  it("treats Shopify write_X as covering read_X", () => {
    expect(
      isConnectorScopeGranted("shopify", "read_orders", ["write_orders"]),
    ).toBe(true);
    // No implicit hierarchy the other way, and not for non-shopify providers.
    expect(
      isConnectorScopeGranted("shopify", "write_orders", ["read_orders"]),
    ).toBe(false);
    expect(
      isConnectorScopeGranted("google_sheets", "read_x", ["write_x"]),
    ).toBe(false);
  });
});
