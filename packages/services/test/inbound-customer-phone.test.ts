import { describe, expect, it } from "vitest";

import { inboundCustomerPhone } from "../src/agent-runtime-helpers.js";

// A Shopify storefront contact-form notification — rigid `Label:\nValue` shape.
const CONTACT_FORM = `You received a new message from your online store's contact form.
Country Code:
US
Name:
Mary Beth Goins
Email:
goodgoins@gmail.com
Phone Number:
2158019255
Comment:
I placed an order on June 18, 2026. It was charged to my Capital One card but I have received no communications or emails to confirm my order or any tracking information.  Can you please look into my order and update me as to status.`;

describe("inboundCustomerPhone", () => {
  it("extracts the phone from a Shopify contact-form email (label on its own line, value on the next)", () => {
    expect(inboundCustomerPhone({ bodyText: CONTACT_FORM })).toBe("2158019255");
  });

  it("handles an inline value after the label", () => {
    expect(
      inboundCustomerPhone({ bodyText: "Phone: (215) 801-9255" }),
    ).toBe("(215) 801-9255");
  });

  it("accepts common label variants (Tel / Mobile / Telephone)", () => {
    expect(inboundCustomerPhone({ bodyText: "Mobile:\n+1 215 801 9255" })).toBe(
      "+1 215 801 9255",
    );
    expect(inboundCustomerPhone({ bodyText: "Tel: 215-801-9255" })).toBe(
      "215-801-9255",
    );
  });

  it("is null when there's no phone field", () => {
    expect(
      inboundCustomerPhone({
        bodyText: "Hi, where is my order #1001? Thanks, placed June 18, 2026.",
      }),
    ).toBeNull();
    expect(inboundCustomerPhone({ bodyText: "" })).toBeNull();
  });

  it("does NOT mistake a non-phone label's value (too few digits) for a phone", () => {
    // A label match whose value can't be a phone must fall through to null,
    // never grab the order date / total that follows.
    expect(
      inboundCustomerPhone({ bodyText: "Phone Number:\nnot provided" }),
    ).toBeNull();
  });
});
