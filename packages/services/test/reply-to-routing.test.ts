import { describe, expect, it } from "vitest";
import { inboundCustomerEmail } from "../src/agent-runtime.js";

describe("inboundCustomerEmail (Reply-To routing)", () => {
  it("prefers Reply-To over From for relay-delivered mail (Shopify contact form)", () => {
    expect(
      inboundCustomerEmail({
        from: { name: "Shopify", email: "mailer@shopify.com" },
        replyTo: { name: "Jane", email: "jane@shopper.com" },
      }),
    ).toBe("jane@shopper.com");
  });

  it("falls back to From when there is no Reply-To", () => {
    expect(
      inboundCustomerEmail({
        from: { name: "Jane", email: "jane@shopper.com" },
        replyTo: null,
      }),
    ).toBe("jane@shopper.com");
    expect(
      inboundCustomerEmail({ from: { name: null, email: "x@y.com" } }),
    ).toBe("x@y.com");
  });

  it("ignores an empty Reply-To email and uses From", () => {
    expect(
      inboundCustomerEmail({
        from: { name: null, email: "real@from.com" },
        replyTo: { name: null, email: "" },
      }),
    ).toBe("real@from.com");
  });
});
