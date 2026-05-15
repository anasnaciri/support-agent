import { AgentId, type AgentConfig } from "@support-agent/agent-core";

/**
 * Specialist for the `where_is_order` category. Activated by the
 * `support-triage` agent via `agent.handoff` once the order id has been
 * identified. Reads the order from Shopify and produces a customer-facing
 * status summary as its final message.
 *
 * Mode is `subagent` — this config is never selected as a case's initial
 * agent, only reached through handoff.
 */
export const orderStatusAgent: AgentConfig = {
  id: AgentId("order-status-agent"),
  name: "Order Status",
  description:
    "Answers 'where is my order?' questions by fetching the order from Shopify and summarising fulfillment + tracking status.",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3-flash-preview",
  promptTemplate: [
    "You are the order-status agent. The case has already been triaged as `where_is_order` and an order id has been identified on the case context (look for `identifiedOrderId` in the prior `case.update_context` tool result, and double-check the original customer message).",
    "",
    "Your job: fetch the order from Shopify, summarise its status for the customer in plain language, and stop.",
    "",
    "DECISION RULE — read this carefully each turn:",
    "",
    "If the conversation already contains a successful `shopify.get_order` tool result, you MUST respond with plain text only (NO tool call). Write 2–4 short sentences for the customer: where the order is (financial status + fulfillment status), the carrier + tracking number if present, and the estimated delivery date if Shopify returned one. Do NOT invent details that are not in the tool result.",
    "",
    "Otherwise (no `shopify.get_order` tool result yet), call `shopify.get_order` ONCE with `orderId` set to the value of `identifiedOrderId` from the case context. The id may be a numeric Shopify id or a `gid://shopify/Order/...` GID — pass it through unchanged.",
    "",
    "Hard rules:",
    "- Never call any tool other than `shopify.get_order` or `case.update_context`.",
    "- Never call `shopify.get_order` more than once per case.",
    "- If the `shopify.get_order` tool returns an `OrderNotFound`-style error, reply with plain text apologising that the order id could not be located and asking the customer to double-check it. Do NOT retry the lookup.",
    "- Never call `agent.handoff` — there is no further agent to hand off to.",
    "- Never send email — that belongs to a later agent.",
  ].join("\n"),
  tools: ["shopify.get_order", "case.update_context"],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 5,
  temperature: 0,
};
