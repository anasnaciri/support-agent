export interface ShopifyBackfillShipment {
  readonly sourceOrderId: string;
  readonly sourceFulfillmentId: string;
  readonly trackingNumber: string;
  readonly carrier: string | null;
  readonly shippedAt: Date | null;
}

export interface ShopifyShipmentBackfillOptions {
  readonly shop: string;
  readonly accessToken: string;
  readonly apiVersion: string;
  readonly onShipment: (shipment: ShopifyBackfillShipment) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
}

interface BackfillResponse {
  readonly data?: {
    readonly orders?: {
      readonly pageInfo?: {
        readonly hasNextPage?: boolean;
        readonly endCursor?: string | null;
      };
      readonly nodes?: ReadonlyArray<{
        readonly id?: string;
        readonly fulfillments?: {
          readonly nodes?: ReadonlyArray<{
            readonly id?: string;
            readonly createdAt?: string;
            readonly trackingInfo?: ReadonlyArray<{
              readonly company?: string | null;
              readonly number?: string | null;
            }>;
          }>;
        };
      }>;
    };
  };
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
}

const SHIPMENT_BACKFILL_QUERY = `
query ShipmentBackfill($cursor: String) {
  orders(first: 100, after: $cursor, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      fulfillments(first: 100) {
        nodes {
          id
          createdAt
          trackingInfo { company number }
        }
      }
    }
  }
}
`;

export const shopifyShipmentBackfill = async (
  opts: ShopifyShipmentBackfillOptions,
): Promise<void> => {
  const f = opts.fetchImpl ?? fetch;
  let cursor: string | null = null;
  do {
    const response = await f(
      `https://${opts.shop}/admin/api/${opts.apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": opts.accessToken,
        },
        body: JSON.stringify({
          query: SHIPMENT_BACKFILL_QUERY,
          variables: { cursor },
        }),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Shopify shipment backfill failed: ${response.status} ${text}`,
      );
    }
    const body = JSON.parse(text) as BackfillResponse;
    if (body.errors?.length) {
      throw new Error(
        `Shopify shipment backfill GraphQL errors: ${body.errors
          .map((error) => error.message ?? "unknown")
          .join("; ")}`,
      );
    }
    const orders = body.data?.orders;
    for (const order of orders?.nodes ?? []) {
      if (!order.id) continue;
      for (const fulfillment of order.fulfillments?.nodes ?? []) {
        if (!fulfillment.id) continue;
        const shippedAt = fulfillment.createdAt
          ? new Date(fulfillment.createdAt)
          : null;
        const seen = new Set<string>();
        for (const tracking of fulfillment.trackingInfo ?? []) {
          const trackingNumber = tracking.number?.trim();
          if (!trackingNumber || seen.has(trackingNumber)) continue;
          seen.add(trackingNumber);
          await opts.onShipment({
            sourceOrderId: order.id,
            sourceFulfillmentId: fulfillment.id,
            trackingNumber,
            carrier: tracking.company?.trim() || null,
            shippedAt:
              shippedAt && !Number.isNaN(shippedAt.getTime())
                ? shippedAt
                : null,
          });
        }
      }
    }
    cursor =
      orders?.pageInfo?.hasNextPage && orders.pageInfo.endCursor
        ? orders.pageInfo.endCursor
        : null;
  } while (cursor);
};
