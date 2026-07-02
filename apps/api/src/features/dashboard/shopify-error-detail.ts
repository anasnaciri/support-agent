import type { ShopifyError } from "@support-agent/agent-core";

// Turn a typed ShopifyError into a human-readable, log-safe one-liner that
// PRESERVES the detail the bare `_tag` throws away. The dashboard refund
// handler used to `throw new Error(result.left._tag)`, collapsing e.g. a
// Shopify GraphQL rejection ("Cannot query field 'code' on type 'UserError'")
// into an opaque "NetworkError" with nothing in the logs — which made a
// one-line schema mismatch take far too long to root-cause. This keeps the
// real message so the NEXT Shopify failure is diagnosable from `req.log`.

const describeCause = (cause: unknown): string => {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) {
    return cause.message ? `${cause.name}: ${cause.message}` : cause.name;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
};

export const describeShopifyError = (e: ShopifyError): string => {
  switch (e._tag) {
    case "OrderNotFound":
      return `order not found (${e.orderId})`;
    case "CustomerNotFound":
      return `customer not found (${e.query})`;
    case "ProductNotFound":
      return `product not found (${e.productId})`;
    case "RefundFailed":
      return `refund rejected${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
    case "DiscountFailed":
      return `discount rejected${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
    case "OrderCancelFailed":
      return `cancel rejected${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
    case "ShopifyRateLimited":
      return "Shopify rate limited";
    case "ShopifyAuthFailed":
      return "Shopify authorization failed (reconnect the store)";
    case "ShopifyAuthMissing":
      return "Shopify not connected";
    case "ShopifyResponseInvalid":
      return `Shopify rejected the request: ${e.message}`;
    case "NetworkError":
      return `network error: ${describeCause(e.cause)}`;
  }
};
