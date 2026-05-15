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
