import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  parseCustomersDataRequest,
  parseCustomersRedact,
  parseShopRedact,
  parseUninstallPayload,
  readRawBody,
} from "../src/shopify-webhook.js";

const asReq = (chunks: ReadonlyArray<string | Buffer>): IncomingMessage =>
  Readable.from(chunks) as unknown as IncomingMessage;

describe("readRawBody", () => {
  it("concatenates chunks into a single buffer", async () => {
    const req = asReq(["{\"a\":", "1}"]);
    const buf = await readRawBody(req);
    expect(buf.toString("utf8")).toBe('{"a":1}');
  });

  it("handles empty bodies", async () => {
    const req = asReq([]);
    const buf = await readRawBody(req);
    expect(buf.length).toBe(0);
  });

  it("preserves raw bytes (no UTF-8 normalization)", async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x42]);
    const req = asReq([raw]);
    const buf = await readRawBody(req);
    expect(buf.equals(raw)).toBe(true);
  });

  it("rejects bodies that exceed maxBytes", async () => {
    const big = Buffer.alloc(2048, 0x61);
    const req = asReq([big]);
    await expect(readRawBody(req, 1024)).rejects.toThrow(/exceeded/);
  });
});

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
