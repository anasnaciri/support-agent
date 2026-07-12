// ============================================================
// Tool display names
// ============================================================
//
// THE single source of truth for the merchant-facing name of every tool.
// Everything that shows a tool to a human reads from here, directly or
// indirectly:
//
//   - `defineTool` stamps `Tool.displayName` from this map (a tool file may
//     still override inline, but the real tools don't — renaming here renames
//     everywhere).
//   - the dashboard catalog DTO carries the stamped `displayName` to the SPA's
//     agent-settings Actions card,
//   - the SPA's id-only surfaces (approval cards, timeline, home) call
//     `toolActionLabel`, whose map is this one (re-exported via labels.ts),
//   - the Telegram bundle ping / bundle review page use it as the summary base
//     in `summarizeApprovalAction`.
//
// Copy register (dashboard conventions): plain language, "you" = the
// merchant, "the customer" = their buyer, no ids, no jargon. Whether a tool
// is VISIBLE on the tenant agent page is a separate axis — `tenantControl` —
// so internal plumbing having a friendly name here leaks nothing; it only
// makes audit rows and future surfaces read as words.

export const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "agent.handoff": "Hand off to a specialist",
  "conversation.ask_customer": "Ask the customer a question",
  "conversation.fetch_thread": "Read the email thread",
  "conversation.reply": "Reply to the customer",
  "discount.create": "Issue a discount code",
  "knowledge.search": "Search your knowledge base",
  "merchant.notify": "Send you a heads-up",
  "order.cancel": "Cancel and refund the order",
  "order.update_shipping_address": "Update the shipping address",
  "order.update_tracking": "Update the tracking number",
  "refund.create": "Issue a refund",
  "refund.recommend": "Recommend a refund",
  "shopify.find_customer_order": "Find a customer's order",
  "shopify.get_customer": "Look up a customer",
  "shopify.get_order": "Look up an order",
  "shopify.get_product": "Look up a product",
  "shopify.get_store_info": "Read store details",
  "shopify.list_pickup_locations": "List pickup locations",
  "shopify.search_products": "Search products",
  "supplier.add_sheet_row": "Log the issue with the supplier",
  "supplier.escalate": "Ask the supplier for help",
  "supplier.read_sheet_columns": "Read the supplier spreadsheet",
  "ticket.update_context": "Record ticket details",
  "ticket.update_status": "Update ticket status",
  "tracking.lookup": "Check shipment tracking",
};

/**
 * Friendly name for a tool id; unknown ids come back verbatim so callers
 * can decide their own fallback (the SPA humanizes the slug, the Telegram
 * summarizer quotes it).
 */
export const toolDisplayName = (name: string): string =>
  TOOL_DISPLAY_NAMES[name] ?? name;
