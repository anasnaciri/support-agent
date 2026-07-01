import { describe, expect, it } from "vitest";

import { inboundCustomerName } from "../src/agent-runtime-helpers.js";

describe("inboundCustomerName", () => {
  it("takes the From display name when there's no Reply-To", () => {
    expect(
      inboundCustomerName({
        from: { name: "Maya Chen", email: "maya@shop.com" },
      }),
    ).toBe("Maya Chen");
  });

  it("trusts the Reply-To name (the human) over the relay's From", () => {
    expect(
      inboundCustomerName({
        from: { name: "Shopify", email: "relay@shopifyemail.com" },
        replyTo: { name: "Tom Bradley", email: "tom@buyer.com" },
      }),
    ).toBe("Tom Bradley");
  });

  it("does NOT fall back to the relay From name when Reply-To has no name", () => {
    // Reply-To is the customer; if it carried no name, attributing the relay's
    // From name to the customer would be wrong.
    expect(
      inboundCustomerName({
        from: { name: "Shopify", email: "relay@shopifyemail.com" },
        replyTo: { name: null, email: "tom@buyer.com" },
      }),
    ).toBeNull();
  });

  it("is null when there's no usable name", () => {
    expect(
      inboundCustomerName({ from: { name: null, email: "x@y.com" } }),
    ).toBeNull();
    expect(
      inboundCustomerName({ from: { name: "   ", email: "x@y.com" } }),
    ).toBeNull();
  });
});
