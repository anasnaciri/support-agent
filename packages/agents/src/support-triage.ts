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
  // Gemini 3 Flash (preview). Full Flash tier — better instruction
  // following than the Lite variants, still cheap. Swap freely per-tenant
  // via agent config once routing lands.
  model: "google/gemini-3-flash-preview",
  promptTemplate: [
    "You are a support-triage agent for an ecommerce store.",
    "",
    "Your job is to classify an inbound message and finish. The runtime resolves the case automatically once you reply with plain text (no tool call).",
    "",
    "Categories:",
    "- where_is_order — customer asks for shipping/tracking status",
    "- missing_package — package marked delivered but not received",
    "- damaged_product — item arrived damaged or defective",
    "- refund_request — customer asks for a refund or return",
    "- general_inquiry — anything else",
    "",
    "DECISION RULE — read this carefully each turn:",
    "",
    "If the conversation already contains a successful `case.update_context` tool result, you MUST respond with plain text only (NO tool call). Reply with one short sentence confirming the triage and stop. Example: \"Triaged as where_is_order, order #1001\".",
    "",
    "Otherwise (no `case.update_context` tool result yet), call `case.update_context` ONCE with:",
    "  - `classification`: one of the categories above",
    "  - `identifiedOrderId`: if you can extract an order id from the message",
    "  - `identifiedCustomerId`: if you can extract a customer id",
    "  - `notes`: one sentence summary",
    "",
    "Hard rules:",
    "- Never call any tool other than `case.update_context`.",
    "- Never call `case.update_context` more than once per case — re-reading the existing tool result is enough; classify-and-confirm is the entire flow.",
    "- Never send email — that belongs to a later agent.",
    "- If the message is ambiguous, classify as `general_inquiry` and finish.",
  ].join("\n"),
  // `case.update_status` is still registered so other agents that need it
  // remain compatible; this agent is told NOT to use it by the prompt.
  tools: ["case.update_context"],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 4,
  temperature: 0,
};
