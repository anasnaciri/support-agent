import { describe, expect, it, vi } from "vitest";
import { shopifyShipmentBackfill } from "../src/shopify-shipment-backfill.js";

describe("shopifyShipmentBackfill", () => {
  it("paginates fulfilled orders and emits every tracked fulfillment", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              orders: {
                pageInfo: { hasNextPage: true, endCursor: "next" },
                nodes: [
                  {
                    id: "gid://shopify/Order/1",
                    fulfillments: {
                      nodes: [
                        {
                          id: "gid://shopify/Fulfillment/1",
                          createdAt: "2026-07-01T00:00:00Z",
                          trackingInfo: [
                            { company: "UPS", number: "1Z1" },
                            { company: "UPS", number: "1Z2" },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              orders: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          }),
        ),
      );
    const seen: unknown[] = [];

    await shopifyShipmentBackfill({
      shop: "acme.myshopify.com",
      accessToken: "token",
      apiVersion: "2026-04",
      fetchImpl: fetchImpl as typeof fetch,
      onShipment: async (shipment) => {
        seen.push(shipment);
      },
    });

    expect(seen).toEqual([
      {
        sourceOrderId: "gid://shopify/Order/1",
        sourceFulfillmentId: "gid://shopify/Fulfillment/1",
        trackingNumber: "1Z1",
        carrier: "UPS",
        shippedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      {
        sourceOrderId: "gid://shopify/Order/1",
        sourceFulfillmentId: "gid://shopify/Fulfillment/1",
        trackingNumber: "1Z2",
        carrier: "UPS",
        shippedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
