import { Effect } from "effect";
import {
  CustomerId,
  OrderId,
  type ShopifyCustomer,
  type ShopifyOrder,
  type TenantId,
} from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";

// Case-detail Shopify panels (Path B slice 6). Ported from the dashboard's
// lib/shopify.ts: read the ids the agent stamped onto `case.context` and
// fetch the matching Shopify entity. Best-effort — any failure (no creds,
// network, 404) resolves to null so the panel renders a graceful fallback.

export const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

export const looksLikeOrderName = (s: string): boolean => /^#?\d+$/.test(s);

export const looksLikeGid = (s: string): boolean =>
  s.startsWith("gid://shopify/Order/") ||
  s.startsWith("gid://shopify/Customer/");

type CaseContext = Readonly<Record<string, unknown>>;

/**
 * Best-effort order for a case's stamped `identifiedOrderId` (a Shopify GID,
 * a customer-facing name like "#1001", or a confirmation number like
 * "XPAV284CT"). Errors map to null. Mirrors `shopify.get_order`'s
 * resolution so the operator's case view shows the same order the agent
 * resolved — a name like `#1001` goes through `findOrderByName`; an
 * alphanumeric code goes through `findOrderByConfirmationNumber`.
 */
export const resolveOrderForContext = (
  tenantId: TenantId,
  context: CaseContext,
): Effect.Effect<ShopifyOrder | null, never, ShopifyService> =>
  Effect.gen(function* () {
    const raw = context["identifiedOrderId"];
    if (!isNonEmptyString(raw)) return null;
    const shopify = yield* ShopifyService;
    const lookup = looksLikeGid(raw)
      ? shopify.getOrder(tenantId, OrderId(raw))
      : looksLikeOrderName(raw)
        ? shopify.findOrderByName(tenantId, raw)
        : shopify.findOrderByConfirmationNumber(tenantId, raw);
    return yield* lookup.pipe(Effect.catchAll(() => Effect.succeed(null)));
  });

/**
 * Best-effort store currency (ISO 4217) for the refund-policy currency
 * warning. Any failure — no Shopify connection, network, auth — resolves
 * to null ("unknown"), so the page just omits the warning.
 */
export const resolveShopCurrencyCode = (
  tenantId: TenantId,
): Effect.Effect<string | null, never, ShopifyService> =>
  Effect.gen(function* () {
    const shopify = yield* ShopifyService;
    return yield* shopify.getShopInfo(tenantId).pipe(
      Effect.map((info) => info.currencyCode),
      Effect.catchAll(() => Effect.succeed(null)),
    );
  });

/**
 * Best-effort customer for a case's `shopifyCustomerId` (preferred) or
 * `customerEmail`. Errors map to null.
 */
export const resolveCustomerForContext = (
  tenantId: TenantId,
  context: CaseContext,
): Effect.Effect<ShopifyCustomer | null, never, ShopifyService> =>
  Effect.gen(function* () {
    const idRaw = context["shopifyCustomerId"];
    const emailRaw = context["customerEmail"];
    if (!isNonEmptyString(idRaw) && !isNonEmptyString(emailRaw)) return null;
    const shopify = yield* ShopifyService;
    const lookup = isNonEmptyString(idRaw)
      ? shopify.getCustomer(tenantId, CustomerId(idRaw))
      : isNonEmptyString(emailRaw)
        ? shopify.searchByEmail(tenantId, emailRaw)
        : Effect.succeed(null);
    return yield* lookup.pipe(Effect.catchAll(() => Effect.succeed(null)));
  });
