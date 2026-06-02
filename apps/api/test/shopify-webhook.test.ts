import { describe, expect, it } from "vitest";
import {
  parseCustomersDataRequest,
  parseCustomersRedact,
  parseShopRedact,
  parseUninstallPayload,
} from "../src/shopify-webhook.js";

describe("parseUninstallPayload", () => {
  it("extracts id, name, domain from a typical Shopify body", () => {
    const buf = Buffer.from(
      JSON.stringify({
        id: 901,
        name: "acme.myshopify.com",
        domain: "acme.com",
        extra: "ignored",
      }),
      "utf8",
    );
    expect(parseUninstallPayload(buf)).toEqual({
      id: 901,
      name: "acme.myshopify.com",
      domain: "acme.com",
    });
  });

  it("returns nulls on malformed JSON", () => {
    expect(parseUninstallPayload(Buffer.from("not json", "utf8"))).toEqual({
      id: null,
      name: null,
      domain: null,
    });
  });

  it("returns nulls for non-object root values", () => {
    expect(parseUninstallPayload(Buffer.from("123", "utf8"))).toEqual({
      id: null,
      name: null,
      domain: null,
    });
    expect(parseUninstallPayload(Buffer.from('"x"', "utf8"))).toEqual({
      id: null,
      name: null,
      domain: null,
    });
  });

  it("returns nulls per-field for missing or wrong-type entries", () => {
    expect(
      parseUninstallPayload(
        Buffer.from(JSON.stringify({ id: "1", name: 7 }), "utf8"),
      ),
    ).toEqual({ id: null, name: null, domain: null });
  });
});

describe("parseCustomersDataRequest", () => {
  it("extracts shop, customer, orders, and data_request id from Shopify's documented shape", () => {
    const buf = Buffer.from(
      JSON.stringify({
        shop_id: 954889,
        shop_domain: "acme.myshopify.com",
        orders_requested: [299938, 280263, 220458],
        customer: {
          id: 191167,
          email: "john@example.com",
          phone: "555-625-1199",
        },
        data_request: { id: 9999 },
      }),
      "utf8",
    );
    expect(parseCustomersDataRequest(buf)).toEqual({
      shopId: 954889,
      shopDomain: "acme.myshopify.com",
      ordersRequested: [299938, 280263, 220458],
      customer: {
        id: 191167,
        email: "john@example.com",
        phone: "555-625-1199",
      },
      dataRequestId: 9999,
    });
  });

  it("returns null fields when keys are missing or malformed", () => {
    expect(
      parseCustomersDataRequest(Buffer.from("garbage", "utf8")),
    ).toEqual({
      shopId: null,
      shopDomain: null,
      ordersRequested: [],
      customer: { id: null, email: null, phone: null },
      dataRequestId: null,
    });
  });
});

describe("parseCustomersRedact", () => {
  it("extracts shop, customer, and orders_to_redact", () => {
    const buf = Buffer.from(
      JSON.stringify({
        shop_id: 954889,
        shop_domain: "acme.myshopify.com",
        customer: {
          id: 191167,
          email: "john@example.com",
          phone: "555-625-1199",
        },
        orders_to_redact: [299938],
      }),
      "utf8",
    );
    expect(parseCustomersRedact(buf)).toEqual({
      shopId: 954889,
      shopDomain: "acme.myshopify.com",
      customer: {
        id: 191167,
        email: "john@example.com",
        phone: "555-625-1199",
      },
      ordersToRedact: [299938],
    });
  });

  it("filters non-number entries out of orders_to_redact", () => {
    const buf = Buffer.from(
      JSON.stringify({
        shop_id: 1,
        shop_domain: "x.myshopify.com",
        customer: { id: 1, email: "x@example.com", phone: null },
        orders_to_redact: [1, "2", 3, null],
      }),
      "utf8",
    );
    expect(parseCustomersRedact(buf).ordersToRedact).toEqual([1, 3]);
  });
});

describe("parseShopRedact", () => {
  it("extracts shop id + domain", () => {
    const buf = Buffer.from(
      JSON.stringify({ shop_id: 954889, shop_domain: "acme.myshopify.com" }),
      "utf8",
    );
    expect(parseShopRedact(buf)).toEqual({
      shopId: 954889,
      shopDomain: "acme.myshopify.com",
    });
  });

  it("returns nulls on malformed JSON", () => {
    expect(parseShopRedact(Buffer.from("?", "utf8"))).toEqual({
      shopId: null,
      shopDomain: null,
    });
  });
});
