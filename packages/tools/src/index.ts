import type { AnyTool } from "@support-agent/agent-core";
import { caseUpdateStatus } from "./case/update-status.js";
import { caseUpdateContext } from "./case/update-context.js";
import { shopifyGetOrder } from "./shopify/get-order.js";
import { shopifyGetCustomer } from "./shopify/get-customer.js";
import { shopifyGetProduct } from "./shopify/get-product.js";
import { shopifyGetStoreInfo } from "./shopify/get-store-info.js";
import { shopifyListPickupLocations } from "./shopify/list-pickup-locations.js";
import { shopifySearchProducts } from "./shopify/search-products.js";
import { shopifyRefundCreate } from "./shopify/refund.js";
import { shopifyRefundRecommend } from "./shopify/recommend-refund.js";
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

export * from "./case/update-status.js";
export * from "./case/update-context.js";
export * from "./shopify/get-order.js";
export * from "./shopify/get-customer.js";
export * from "./shopify/get-product.js";
export * from "./shopify/get-store-info.js";
export * from "./shopify/list-pickup-locations.js";
export * from "./shopify/search-products.js";
export * from "./shopify/refund.js";
export * from "./shopify/recommend-refund.js";
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
 * Order groups tools by domain for readable rendering: case → agent
 * (runtime-control) → conversation → shopify.
 *
 * The per-element `as AnyTool` cast widens `Tool<I, O>` to
 * `Tool<unknown, unknown>`. Effect Schema is contravariant in its
 * input type, so the assignment fails under `exactOptionalPropertyTypes`
 * without the cast — same pattern the worker bootstrap used before
 * the list moved here.
 */
export const ALL_TOOLS: ReadonlyArray<AnyTool> = [
  caseUpdateContext as AnyTool,
  caseUpdateStatus as AnyTool,
  agentHandoff as AnyTool,
  conversationFetchThread as AnyTool,
  conversationReply as AnyTool,
  conversationAskCustomer as AnyTool,
  shopifyGetOrder as AnyTool,
  shopifyGetCustomer as AnyTool,
  shopifyGetProduct as AnyTool,
  shopifyGetStoreInfo as AnyTool,
  shopifyListPickupLocations as AnyTool,
  shopifySearchProducts as AnyTool,
  shopifyRefundCreate as AnyTool,
  shopifyRefundRecommend as AnyTool,
  supplierReadSheetColumns as AnyTool,
  supplierAddSheetRow as AnyTool,
  supplierEscalate as AnyTool,
  trackingLookup as AnyTool,
  knowledgeSearch as AnyTool,
  merchantNotify as AnyTool,
];
