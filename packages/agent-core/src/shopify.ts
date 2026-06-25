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
  /**
   * Shopify's customer-facing confirmation number — a random alphanumeric
   * code (e.g. "XPAV284CT") shown on the order confirmation page/email,
   * often *instead of* the sequential order name. Customers frequently
   * quote this when they can't find the `#1001`-style name, so we surface
   * it both for display and as a lookup key (see
   * `ShopifyService.findOrderByConfirmationNumber`). `null` when the order
   * predates the field or the store doesn't expose it. Not guaranteed
   * unique across orders — never treat a match as proof of identity; the
   * order-email identity gate still applies.
   */
  readonly confirmationNumber: string | null;
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

/**
 * One product option axis as shown on the storefront, e.g.
 * `{ name: "Size", values: ["S", "M", "L"] }`. The provider drops
 * Shopify's placeholder option (`Title: Default Title`) for
 * single-variant products, so an empty array means "no options".
 */
export type ShopifyProductOption = {
  readonly name: string;
  readonly values: ReadonlyArray<string>;
};

/**
 * A variant as it appears in a search result. `availableForSale` is the
 * customer-facing storefront boolean — never an inventory count (we
 * deliberately don't read stock quantities). `price` carries the store
 * currency taken from the product's price range; it is never defaulted.
 */
export type ShopifyProductVariantSummary = {
  readonly title: string; // e.g. "Blue / M"
  readonly price: ShopifyMoney;
  readonly availableForSale: boolean;
};

/**
 * A product as it appears in a catalog *search* result. Lighter than
 * `ShopifyProduct`: no images (search answers "do you sell X?" and basic
 * attribute questions from text), and it carries a plain-text
 * `description` so an agent can ground its answer in the merchant's own
 * product copy rather than inventing specs. `description` is the
 * storefront body text, truncated by the provider to keep token cost
 * bounded; `null` when the product has no description.
 *
 * The pre-sale grounding fields are all customer-facing by construction:
 * `priceMin`/`priceMax` mirror the storefront price range (single price →
 * min equals max); `availableForSale` is true when any variant is
 * purchasable (a boolean, never a stock count); `onlineStoreUrl` is
 * Shopify's canonical product URL and is `null` when the product isn't
 * published to the Online Store channel — callers must not synthesise a
 * URL from the handle in that case. `variants` is capped by the provider
 * and collapsed to `[]` for single-variant products (the price range and
 * availability flag already carry their information). Used by
 * `shopify.search_products`.
 */
export type ShopifyProductSearchResult = {
  readonly id: string; // gid://shopify/Product/...
  readonly title: string;
  readonly productType: string | null;
  readonly vendor: string | null;
  readonly description: string | null;
  readonly priceMin: ShopifyMoney;
  readonly priceMax: ShopifyMoney;
  readonly availableForSale: boolean;
  readonly onlineStoreUrl: string | null;
  readonly options: ReadonlyArray<ShopifyProductOption>;
  readonly variants: ReadonlyArray<ShopifyProductVariantSummary>;
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

/**
 * How a discount code's value is expressed. `percentage` is a whole-or-
 * decimal percent off the order (`value: "10"` ⇒ 10% off); `fixed_amount`
 * is a flat money amount off (`value: "5.00"` in `currencyCode`). These are
 * the only two shapes a basic code discount (`discountCodeBasicCreate`)
 * carries — we deliberately don't model BXGY / free-shipping codes here.
 */
export type ShopifyDiscountValueType = "percentage" | "fixed_amount";

/**
 * Result of a successful `discountCodeBasicCreate` mutation — a single
 * coupon code created as a goodwill / service-recovery gesture. The shape
 * is intentionally narrow: just what the agent and dashboard need to
 * confirm the code landed and surface it to the customer.
 *
 * Guardrails the platform always forces (never agent-chosen) are reflected
 * here so callers can audit them: the code is single-use
 * (`usageLimit: 1`), locked to one customer (`customerId`), non-combinable,
 * and always carries an `endsAt` expiry. `value` is a decimal string —
 * a percent when `valueType === "percentage"` (and `currencyCode` is
 * `null`), or a money amount when `fixed_amount` (with `currencyCode`
 * populated). We never invent a currency for a percentage discount.
 */
export type ShopifyDiscount = {
  readonly id: string; // gid://shopify/DiscountCodeNode/...
  readonly code: string; // the customer-facing code, e.g. "SORRY-7Q2K"
  readonly title: string;
  readonly valueType: ShopifyDiscountValueType;
  readonly value: string; // decimal string: "10" (percent) or "5.00" (amount)
  readonly currencyCode: string | null; // populated for fixed_amount; null for percentage
  readonly customerId: CustomerId; // the single customer the code is locked to
  readonly usageLimit: number; // always 1 in v1
  readonly endsAt: Date;
  readonly createdAt: Date;
};
