import type { AnyTool } from "@support-agent/agent-core";
import { ticketUpdateStatus } from "./ticket/update-status.js";
import { ticketUpdateContext } from "./ticket/update-context.js";
import { shopifyGetOrder } from "./shopify/get-order.js";
import { shopifyFindCustomerOrder } from "./shopify/find-customer-order.js";
import { shopifyGetCustomer } from "./shopify/get-customer.js";
import { shopifyGetProduct } from "./shopify/get-product.js";
import { shopifyGetStoreInfo } from "./shopify/get-store-info.js";
import { shopifyListPickupLocations } from "./shopify/list-pickup-locations.js";
import { shopifySearchProducts } from "./shopify/search-products.js";
import { shopifyRefundCreate } from "./shopify/refund.js";
import { shopifyRefundRecommend } from "./shopify/recommend-refund.js";
import { shopifyDiscountCreate } from "./shopify/discount.js";
import { shopifyOrderCancel } from "./shopify/cancel-order.js";
import { shopifyUpdateShippingAddress } from "./shopify/update-shipping-address.js";
import { agentHandoff } from "./agent/handoff.js";
import { conversationFetchThread } from "./conversation/fetch-thread.js";
import { conversationReply } from "./conversation/reply.js";
import { conversationAskCustomer } from "./conversation/ask-customer.js";
import { supplierAddSheetRow } from "./supplier/add-sheet-row.js";
import { supplierReadSheetColumns } from "./supplier/read-sheet-columns.js";
import { supplierEscalate } from "./supplier/escalate.js";
import { trackingLookup } from "./tracking/lookup.js";
import { knowledgeSearch } from "./knowledge/search.js";
import { merchantNotify } from "./merchant/notify.js";

export * from "./ticket/update-status.js";
export * from "./ticket/update-context.js";
export * from "./shopify/get-order.js";
export * from "./shopify/find-customer-order.js";
export * from "./shopify/get-customer.js";
export * from "./shopify/get-product.js";
export * from "./shopify/get-store-info.js";
export * from "./shopify/list-pickup-locations.js";
export * from "./shopify/search-products.js";
export * from "./shopify/refund.js";
export * from "./shopify/recommend-refund.js";
export * from "./shopify/discount.js";
export * from "./shopify/cancel-order.js";
export * from "./shopify/update-shipping-address.js";
export * from "./agent/handoff.js";
export * from "./conversation/fetch-thread.js";
export * from "./conversation/reply.js";
export * from "./conversation/ask-customer.js";
export * from "./supplier/add-sheet-row.js";
export * from "./supplier/read-sheet-columns.js";
export * from "./supplier/escalate.js";
export * from "./tracking/lookup.js";
export * from "./knowledge/search.js";
export * from "./merchant/notify.js";

/**
 * Canonical list of every tool the platform ships with. Same pattern
 * as `ALL_AGENTS` in @support-agent/agents — single source of truth so
 * the worker bootstrap, dashboard catalog, and any future tool-aware
 * surface stay in sync. Adding a new tool means adding it here exactly
 * once.
 *
 * Order groups tools by domain for readable rendering: ticket → agent
 * (runtime-control) → conversation → shopify.
 *
 * The per-element `as AnyTool` cast widens `Tool<I, O>` to
 * `Tool<unknown, unknown>`. Effect Schema is contravariant in its
 * input type, so the assignment fails under `exactOptionalPropertyTypes`
 * without the cast — same pattern the worker bootstrap used before
 * the list moved here.
 */
export const ALL_TOOLS: ReadonlyArray<AnyTool> = [
  ticketUpdateContext as AnyTool,
  ticketUpdateStatus as AnyTool,
  agentHandoff as AnyTool,
  conversationFetchThread as AnyTool,
  conversationReply as AnyTool,
  conversationAskCustomer as AnyTool,
  shopifyGetOrder as AnyTool,
  shopifyFindCustomerOrder as AnyTool,
  shopifyGetCustomer as AnyTool,
  shopifyGetProduct as AnyTool,
  shopifyGetStoreInfo as AnyTool,
  shopifyListPickupLocations as AnyTool,
  shopifySearchProducts as AnyTool,
  shopifyRefundCreate as AnyTool,
  shopifyRefundRecommend as AnyTool,
  shopifyDiscountCreate as AnyTool,
  shopifyOrderCancel as AnyTool,
  shopifyUpdateShippingAddress as AnyTool,
  supplierReadSheetColumns as AnyTool,
  supplierAddSheetRow as AnyTool,
  supplierEscalate as AnyTool,
  trackingLookup as AnyTool,
  knowledgeSearch as AnyTool,
  merchantNotify as AnyTool,
];

/**
 * Tools a merchant CANNOT assign to a custom agent — they are runtime/control
 * plumbing, not capabilities a merchant picks:
 *   - `agent.handoff` is implicit (the runtime grants it when the agent has
 *     handoff targets), never chosen directly.
 *   - `ticket.update_context` / `ticket.update_status` are ticket-bookkeeping the
 *     triage flow + runtime own; a custom specialist records nothing through
 *     them in v1.
 * Everything else (read tools, customer messaging, refunds) is assignable and
 * gated at runtime by the PermissionService (approval defaults + connector
 * scopes), so "all tools, gated" holds without special-casing money tools.
 */
export const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "agent.handoff",
  "ticket.update_context",
  "ticket.update_status",
]);

/** Tools a merchant may assign to a custom agent (ALL_TOOLS minus internal). */
export const ASSIGNABLE_TOOLS: ReadonlyArray<AnyTool> = ALL_TOOLS.filter(
  (t) => !INTERNAL_TOOL_NAMES.has(t.name),
);

export const ASSIGNABLE_TOOL_NAMES: ReadonlySet<string> = new Set(
  ASSIGNABLE_TOOLS.map((t) => t.name),
);
