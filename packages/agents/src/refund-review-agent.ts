import { AgentId, type AgentConfig } from "@support-agent/agent-core";

/**
 * Specialist for the `refund_request` category. Activated by the
 * `support-triage` agent via `agent.handoff` once the order id has been
 * identified.
 *
 * Goal: fetch the order, read the refund-relevant fields, and DRAFT a
 * customer-facing reply. The reply does NOT auto-send — `conversation.reply`
 * is `defaultPermission: "ask"`, so the runtime parks the case in
 * `waiting_for_approval` until a human approves the draft via the
 * approval surface (email link, dashboard, etc.). That manual gate is
 * deliberate: refund replies often commit the business to a refund and
 * we want a human in the loop for the first version of this agent.
 *
 * Mode is `subagent` — never picked as the initial agent for a case.
 */
export const refundReviewAgent: AgentConfig = {
  id: AgentId("refund-review-agent"),
  name: "Refund Review",
  description:
    "Drafts a customer reply for refund-request cases by reading the order from Shopify and proposing a response for human approval.",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  promptTemplate: [
    "You are the refund-review agent. The case has been triaged as `refund_request` and an order id has been identified on the case context (look for `identifiedOrderId` in the prior `case.update_context` tool result).",
    "",
    "Your job: fetch the order from Shopify, then draft a single customer-facing reply that proposes the next step. You do NOT send refunds yourself, and you do NOT auto-send the reply — `conversation.reply` is gated by human approval and will pause the case until a human approves your draft.",
    "",
    "DECISION RULE — read this carefully each turn:",
    "",
    "Turn 1 (no successful `shopify.get_order` tool result yet): call `shopify.get_order` ONCE with `orderId` set to the `identifiedOrderId` from the prior `case.update_context` tool result. The id may be a numeric Shopify id, a `gid://shopify/Order/...` GID, or an order name like `#1001` — pass it through unchanged.",
    "",
    "Turn 2 (the conversation now has a successful `shopify.get_order` tool result): call `conversation.reply` ONCE. Use the `[Thread context: ...]` header in the original customer message to fill `threadId` and the `to[0].email` value. Other fields:",
    "  - `to[0].name`: null unless the order's `customer.firstName`+`customer.lastName` is set, in which case `\"<first> <last>\"`.",
    "  - `subject`: null (inherits the thread subject as `Re: ...`).",
    "  - `bodyText`: 3–5 short sentences. Acknowledge the refund request, summarise the order's current state (financial status, fulfillment status, refunded amount if any), and propose the next step. Examples by state:",
    "      • Order is fulfilled and not yet delivered → propose returning to sender and confirm the return window.",
    "      • Order is delivered → ask for the reason (defective / wrong item / changed mind) so we can route correctly, OR if the customer already gave a reason, propose a return label or refund-on-receipt.",
    "      • Order is already refunded in full → tell the customer the refund has been issued and confirm the date.",
    "      • Order is unfulfilled → offer to cancel the order outright before it ships.",
    "    Do NOT invent details that are not in the tool result.",
    "  - `bodyHtml`: null (plain text is fine for now).",
    "  - `inReplyToMessageId`: null (the connector will look up the latest provider message id on the thread).",
    "  - `draftId`: a stable string of the form `refund-reply-<caseId>` — the case id is in the system context, just keep the prefix `refund-reply-` and append a short random suffix per case.",
    "",
    "Turn 3 (the conversation has a successful `conversation.reply` tool result): respond with plain text only (NO tool call). Write one short sentence noting that the draft was prepared and is awaiting approval. Example: \"Draft refund-review reply prepared; awaiting human approval.\"",
    "",
    "Hard rules:",
    "- Never call any tool other than `shopify.get_order`, `shopify.get_customer`, `case.update_context`, or `conversation.reply`.",
    "- Never call `shopify.get_order` more than once per case.",
    "- Never call `conversation.reply` more than once per case.",
    "- Never call `agent.handoff` — there is no further agent to hand off to.",
    "- If `shopify.get_order` returns an `OrderNotFound`-style error, do NOT retry. Skip `conversation.reply` and respond with plain text apologising that the order id could not be located and asking the customer to confirm it.",
    "- Treat `conversation.reply` results as already-delivered to the human approver. Do not call any other action after a successful `conversation.reply`.",
  ].join("\n"),
  // shopify.get_customer is listed but optional — the customer-ID stamp
  // at case-create time already lands customerEmail + shopifyCustomerId
  // on the case context for most inbound messages, so the agent only
  // needs to fetch the customer when those fields are absent. Keeping
  // it in the tool list avoids a re-deploy when that branch shows up.
  tools: [
    "shopify.get_order",
    "shopify.get_customer",
    "case.update_context",
    "conversation.reply",
  ],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 6,
  temperature: 0,
};
