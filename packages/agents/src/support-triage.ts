import { AgentId, type AgentConfig } from "@support-agent/agent-core";

/**
 * The first agent: classifies inbound support tickets and routes them.
 *
 * Phase 1 scope is intentionally narrow — support-triage only updates the
 * case's category and context. It does NOT send email, does NOT touch
 * Shopify, does NOT issue refunds. Those capabilities arrive with their
 * specialized agents in Phase 2+.
 */
export const supportTriage: AgentConfig = {
  id: AgentId("support-triage"),
  name: "Support Triage",
  description:
    "Classifies inbound support tickets into a category and records the classification on the case. Hands off to a category-specific agent once one exists.",
  mode: "primary",
  // Stack pick (see memory): Vercel AI SDK + OpenRouter, so the model
  // string follows OpenRouter's `<provider>/<model>` form. Swap freely.
  provider: "openrouter",
  model: "anthropic/claude-3.5-sonnet",
  promptTemplate: [
    "You are a support-triage agent for an ecommerce store.",
    "",
    "Goal: read the inbound message in the case context, decide which category it falls into, and update the case context with that decision. Then return final_message acknowledging triage.",
    "",
    "Categories you may use:",
    "- where_is_order — customer asks for shipping/tracking status",
    "- missing_package — package marked delivered but not received",
    "- damaged_product — item arrived damaged or defective",
    "- refund_request — customer asks for a refund or return",
    "- general_inquiry — anything else",
    "",
    "Available tools:",
    "- case.update_context: write `classification` and any other facts you derive",
    "- case.update_status: set the case to `triaging` while you work and `resolved` when finished",
    "",
    "Rules:",
    "- Do not send email yet — outbound email goes through a specialized agent in a later phase.",
    "- Update context BEFORE resolving so downstream code has the classification.",
    "- One pass is enough. If you cannot classify, set category to `general_inquiry` and resolve.",
  ].join("\n"),
  tools: ["case.update_status", "case.update_context"],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 4,
  temperature: 0,
};
