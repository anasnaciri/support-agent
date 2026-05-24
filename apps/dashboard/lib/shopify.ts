import "server-only";
import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import {
  CustomerId,
  OrderId,
  TenantId,
  type ShopifyCustomer,
  type ShopifyOrder,
} from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";
import { connectorConnections } from "@support-agent/db";
import { db } from "./db";
import { runShopify } from "./shopify-runtime";

// Surface for case-detail panels. Reads the IDs the agent stamped onto
// `case.context` and fetches the matching Shopify entity. Returns null
// on any failure (no creds, network, 404) — the panel renders a graceful
// fallback rather than crashing the page.
//
// Master-plan §13 expects these panels to be cheap to render alongside
// the timeline. The helpers run in parallel from the case detail page
// (`Promise.all`), so Shopify latency adds at most one round-trip to
// page load, not two.

type CaseContext = Readonly<Record<string, unknown>>;

const isString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

const looksLikeOrderName = (s: string): boolean => /^#?\d+$/.test(s);

const looksLikeGid = (s: string): boolean =>
  s.startsWith("gid://shopify/Order/") ||
  s.startsWith("gid://shopify/Customer/");

export const fetchOrderForCase = async (
  tenantId: TenantId,
  context: CaseContext,
): Promise<ShopifyOrder | null> => {
  const raw = context["identifiedOrderId"];
  if (!isString(raw)) return null;
  return runShopify(
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;
      // The runtime stamps either a Shopify GID (preferred — set by
      // `shopify.get_order` after a tool call) or a customer-facing
      // name like "#1001" (set by `case.update_context` during triage,
      // before any lookup has happened). Try both shapes.
      if (looksLikeGid(raw)) {
        return yield* shopify.getOrder(tenantId, OrderId(raw));
      }
      if (looksLikeOrderName(raw)) {
        return yield* shopify.findOrderByName(tenantId, raw);
      }
      return yield* shopify.getOrder(tenantId, OrderId(raw));
    }),
  );
};

/**
 * Returns the shop domain of the tenant's active Shopify connection,
 * or null if there isn't one. Used by the case detail page to build
 * deep links into the merchant's Shopify admin (orders, customers,
 * etc.). One row per tenant in practice — `connector_connections`
 * carries one active Shopify row per tenant (the install flow revokes
 * any prior active row before writing the new one).
 */
export const fetchShopifyShopDomain = async (
  tenantId: TenantId,
): Promise<string | null> => {
  const rows = await db()
    .select({ shopDomain: connectorConnections.shopDomain })
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.tenantId, tenantId),
        eq(connectorConnections.provider, "shopify"),
        eq(connectorConnections.status, "active"),
      ),
    )
    .limit(1);
  return rows[0]?.shopDomain ?? null;
};

export const fetchCustomerForCase = async (
  tenantId: TenantId,
  context: CaseContext,
): Promise<ShopifyCustomer | null> => {
  const idRaw = context["shopifyCustomerId"];
  const emailRaw = context["customerEmail"];
  if (!isString(idRaw) && !isString(emailRaw)) return null;
  return runShopify(
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;
      if (isString(idRaw)) {
        return yield* shopify.getCustomer(tenantId, CustomerId(idRaw));
      }
      if (isString(emailRaw)) {
        return yield* shopify.searchByEmail(tenantId, emailRaw);
      }
      return null;
    }),
  );
};
