import type { CustomerId, OrderId } from "./ids.js";

/**
 * Domain types for Shopify entities used by `ShopifyService` and the
 * `shopify.*` tool family. These intentionally model only the fields we
 * surface to the agent — not the full Admin API response. Keeping the
 * shape narrow here means tools and prompts don't get flooded with
 * irrelevant fields and we can swap the provider impl without changing
 * tool contracts.
 */

export type ShopifyMoney = {
  readonly amount: string; // decimal string, e.g. "12.99"
  readonly currencyCode: string; // ISO-4217, e.g. "USD"
};

export type ShopifyAddress = {
  readonly name: string | null;
  readonly address1: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  readonly zip: string | null;
  readonly phone: string | null;
};

export type ShopifyLineItem = {
  readonly id: string;
  readonly title: string;
  readonly quantity: number;
  readonly sku: string | null;
  readonly variantTitle: string | null;
  /**
   * GID of the product this line item was sold from
   * (`gid://shopify/Product/...`), or null for custom/deleted items.
   * Surfaced so an agent can pull the product's reference images via
   * `shopify.get_product` and cross-check them against customer-supplied
   * photos (the damaged-product product-match check).
   */
  readonly productId: string | null;
};

/**
 * Order status fields we surface. Shopify exposes several related fields
 * (`displayFulfillmentStatus`, `displayFinancialStatus`); we map both to
 * the plain enums the agent can reason about.
 */
export type ShopifyFulfillmentStatus =
  | "unfulfilled"
  | "partial"
  | "fulfilled"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "attempted_delivery"
  | "failure"
  | "restocked";

export type ShopifyFinancialStatus =
  | "pending"
  | "authorized"
  | "partially_paid"
  | "paid"
  | "partially_refunded"
  | "refunded"
  | "voided";

export type ShopifyFulfillment = {
  readonly id: string;
  readonly status: ShopifyFulfillmentStatus;
  readonly trackingCompany: string | null;
  readonly trackingNumbers: ReadonlyArray<string>;
  readonly trackingUrls: ReadonlyArray<string>;
  readonly estimatedDeliveryAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ShopifyOrder = {
  readonly id: OrderId;
  readonly name: string; // e.g. "#1001"
  readonly email: string | null;
  readonly customerId: CustomerId | null;
  readonly fulfillmentStatus: ShopifyFulfillmentStatus | null;
  readonly financialStatus: ShopifyFinancialStatus | null;
  readonly totalPrice: ShopifyMoney;
  readonly shippingAddress: ShopifyAddress | null;
  readonly lineItems: ReadonlyArray<ShopifyLineItem>;
  readonly fulfillments: ReadonlyArray<ShopifyFulfillment>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ShopifyProductImage = {
  readonly url: string;
  readonly altText: string | null;
};

/**
 * A product as the agent sees it. Intentionally narrow — just enough to
 * cross-check the depicted item against a customer's damage photos:
 * the title/type/vendor for textual context and `images[]` for the
 * reference photos the model compares against. Variants and pricing are
 * out of scope here (use the order line items for what the customer
 * actually bought).
 */
export type ShopifyProduct = {
  readonly id: string; // gid://shopify/Product/...
  readonly title: string;
  readonly productType: string | null;
  readonly vendor: string | null;
  readonly images: ReadonlyArray<ShopifyProductImage>;
};

export type ShopifyCustomer = {
  readonly id: CustomerId;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly ordersCount: number;
  readonly totalSpent: ShopifyMoney;
  readonly defaultAddress: ShopifyAddress | null;
  readonly createdAt: Date;
};

/**
 * Result of a successful `refundCreate` mutation. Surfaces just the
 * fields the agent / dashboard need to confirm the refund landed —
 * Shopify's `Refund` type has many more, but most are derivable from
 * a follow-up `getOrder` if the operator wants them.
 */
export type ShopifyRefund = {
  readonly id: string;
  readonly orderId: OrderId;
  readonly amount: ShopifyMoney;
  readonly note: string | null;
  readonly createdAt: Date;
};
