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
 * Best-effort order for the case's bound order. The single source of truth is
 * the canonical `identifiedOrderId` — a stable Shopify GID the runtime stamps
 * once an order tool resolves the order — which we resolve EXACTLY via
 * `getOrder(gid)`. Before that has happened (an in-flight case) we fall back to
 * the customer's `quotedOrderRef` hint so the panel isn't blank; legacy cases
 * whose `identifiedOrderId` still holds a fuzzy name/confirmation code resolve
 * through the same `shopify.get_order`-style heuristics (`findOrderByName` for a
 * `#1001`, `findOrderByConfirmationNumber` for an alphanumeric code). Errors map
 * to null so the panel renders a graceful fallback.
 */
export const resolveOrderForContext = (
  tenantId: TenantId,
  context: CaseContext,
): Effect.Effect<ShopifyOrder | null, never, ShopifyService> =>
  Effect.gen(function* () {
    const canonical = context["identifiedOrderId"];
    const quoted = context["quotedOrderRef"];
    const raw = isNonEmptyString(canonical)
      ? canonical
      : isNonEmptyString(quoted)
        ? quoted
        : null;
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
 * Single source of truth for the case's customer, resolved through ONE ordered
 * chain of fallbacks (never several independent lookups racing to fill the same
 * slot). Precedence, most-trusted first:
 *
 *   1. `shopifyCustomerId` — the CANONICAL id the runtime stamps only on a
 *      positive email match (`agent-runtime` enrichCase). Trusted; agents
 *      cannot write it.
 *   2. the bound order's `customerId` — when the order resolved but the sender
 *      address didn't match (a typo'd-at-checkout email), the order still
 *      carries its real customer. This is what keeps the panel from showing
 *      "No matching Shopify customer" on an otherwise-identified case.
 *   3. `searchByEmail(customerEmail)` — the sender address, in case Shopify
 *      creds were connected only after the case was created (so step 1 never
 *      ran) and the addresses do line up.
 *   4. `searchByPhone(customerPhone)` — when the email matched no account
 *      (guest checkout, or a personal reply-to that differs from the store
 *      email). Phone is fairly unique, so a hit is a reasonable identification.
 *   5. `searchByName(customerName)` — LAST-resort, deliberately fuzzy: returns
 *      the first customer Shopify matches by name. May be the wrong person for
 *      a common name, so it's only ever used to populate the display panel,
 *      never as an identity gate.
 *   6. `identifiedCustomerId` — the UNTRUSTED hint an agent recorded via
 *      `case.update_context`. Last resort, never ahead of the verified id.
 *
 * Steps 3–5 (email → phone → name) are the merchant-fillable identifiers on the
 * Customer-card pencil: whatever they know, tried in order of reliability.
 *
 * `boundOrder` is the already-resolved order from `resolveOrderForContext`
 * (the caller resolves it first), passed in so we don't fetch it twice. Every
 * step is best-effort: any failure falls through to the next, and an
 * all-misses chain resolves to null so the panel renders its empty state.
 */
export const resolveCustomerForContext = (
  tenantId: TenantId,
  context: CaseContext,
  boundOrder: ShopifyOrder | null,
): Effect.Effect<ShopifyCustomer | null, never, ShopifyService> =>
  Effect.gen(function* () {
    const shopify = yield* ShopifyService;
    const byId = (id: string) =>
      shopify
        .getCustomer(tenantId, CustomerId(id))
        .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const canonical = context["shopifyCustomerId"];
    if (isNonEmptyString(canonical)) {
      const c = yield* byId(canonical);
      if (c) return c;
    }

    if (boundOrder?.customerId) {
      const c = yield* byId(boundOrder.customerId);
      if (c) return c;
    }

    const email = context["customerEmail"];
    if (isNonEmptyString(email)) {
      const c = yield* shopify
        .searchByEmail(tenantId, email)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (c) return c;
    }

    const phone = context["customerPhone"];
    if (isNonEmptyString(phone)) {
      const c = yield* shopify
        .searchByPhone(tenantId, phone)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (c) return c;
    }

    const name = context["customerName"];
    if (isNonEmptyString(name)) {
      const c = yield* shopify
        .searchByName(tenantId, name)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (c) return c;
    }

    const hint = context["identifiedCustomerId"];
    if (isNonEmptyString(hint)) {
      const c = yield* byId(hint);
      if (c) return c;
    }

    return null;
  });
