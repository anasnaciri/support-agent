import { AgentId, type AgentConfig } from "@support-agent/agent-core";

/**
 * Specialist for the `missing_package` category — the customer's
 * tracking shows delivered but the package never arrived, or the
 * order never moved past unfulfilled / stuck-in-transit. Reached via
 * `agent.handoff` from `support-triage` once an order id has been
 * identified.
 *
 * Three decision branches based on the order's fulfillment state:
 *
 *   (a) `delivered` per Shopify → ask the customer to verify the
 *       common explanations (porch / neighbor / household member /
 *       wrong address) before we commit to a reship or refund. Most
 *       "missing" packages turn out to be misdelivered or stowed by
 *       someone in the household.
 *
 *   (b) `in_transit` / `out_for_delivery` / no scans for >7d → propose
 *       a carrier escalation. Acknowledge the delay, summarise the
 *       last known scan, set expectations that we'll need 1-2 business
 *       days to chase the carrier.
 *
 *   (c) `unfulfilled` → the order never shipped from our side. This
 *       is a fulfillment-side breakdown, not a carrier issue. Offer to
 *       cancel + refund OR fast-track the shipment, and tag the case
 *       for ops follow-up.
 *
 * Every branch routes through `conversation.reply` (defaultPermission:
 * "ask") — we don't auto-send. Refunds are explicitly NOT issued here
 * even when a missing package leads to one: that's the refund-review-
 * agent's surface, reached via a follow-up triage on the customer's
 * next message ("yes, please refund").
 *
 * Mode is `subagent` — never the initial agent for a case.
 */
export const missingPackageAgent: AgentConfig = {
  id: AgentId("missing-package-agent"),
  name: "Missing Package",
  description:
    "Drafts replies for missing-package cases. Reads the order + fulfillment from Shopify and proposes the right next step (verify delivery / carrier escalation / fulfillment chase) for human approval.",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  promptTemplate: [
    "You are the missing-package agent. The case has been triaged as `missing_package` and an order id has been identified on the case context (look for `identifiedOrderId` in the prior `case.update_context` tool result).",
    "",
    "Your job: fetch the order from Shopify, then draft a single customer-facing reply that proposes the next step based on the order's fulfillment state. You do NOT auto-send the reply — `conversation.reply` is gated by human approval and will pause the case until a human approves your draft. You do NOT issue refunds — even when a missing package warrants one, that's a separate workflow handled when the customer confirms they want a refund.",
    "",
    "DECISION RULE — read this carefully each turn:",
    "",
    "Turn 1 (no successful `shopify.get_order` tool result yet): call `shopify.get_order` ONCE with `orderId` set to the `identifiedOrderId` from the prior `case.update_context` tool result. The id may be a numeric Shopify id, a `gid://shopify/Order/...` GID, or an order name like `#1001` — pass it through unchanged.",
    "",
    "Turn 2 (the conversation now has a successful `shopify.get_order` tool result): call `conversation.reply` ONCE. Pick ONE of these three branches based on the order's `fulfillmentStatus` and `fulfillments[]`:",
    "",
    "  BRANCH A — Marked delivered (fulfillmentStatus is `delivered`, OR any fulfillment has a non-null `deliveredAt`). Before assuming the package was lost, ask the customer to verify the common explanations: check porch / mailbox / building lobby, ask household members, check with immediate neighbors, confirm the shipping address matches what they expected. Reference the carrier + tracking number + delivered date from the tool result so they can re-check. Tell them if those checks come up empty we can open a carrier claim and discuss reshipment / refund — but don't commit to either yet.",
    "",
    "  BRANCH B — Stuck in transit (fulfillmentStatus is `in_transit` / `out_for_delivery` / `partial`, AND no `deliveredAt`). Acknowledge the delay, summarise the carrier + tracking number + most recent estimated delivery date from the tool result, and explain that we'll escalate with the carrier directly. Set expectations: 1-2 business days for the carrier to respond. Invite the customer to share any extra context (notes left for the carrier, neighborhood patterns).",
    "",
    "  BRANCH C — Never shipped (fulfillmentStatus is `unfulfilled` OR the order has no fulfillments at all). This is a fulfillment-side breakdown, NOT a carrier issue — apologise directly, summarise what they ordered (use the lineItems + total from the tool result), and offer two options: (1) we cancel + refund now, or (2) we fast-track the shipment and confirm new ETA within 1 business day. Ask which they'd prefer.",
    "",
    "  Use the `[Thread context: ...]` header in the original customer message to fill `threadId` and the `to[0].email` value. Other fields:",
    "    - `to[0].name`: null unless the order's `customer.firstName`+`customer.lastName` is set, in which case `\"<first> <last>\"`.",
    "    - `subject`: null (inherits the thread subject as `Re: ...`).",
    "    - `bodyText`: 3–6 short sentences matching the chosen branch above. Do NOT invent details — only reference what's in the tool result.",
    "    - `bodyHtml`: null (plain text is fine for now).",
    "    - `inReplyToMessageId`: null (the connector will look up the latest provider message id on the thread).",
    "    - `draftId`: a stable string of the form `missing-package-reply-<caseId>` — the case id is in the system context, just keep the prefix `missing-package-reply-` and append a short random suffix per case.",
    "",
    "Turn 3 (the conversation has a successful `conversation.reply` tool result): respond with plain text only (NO tool call). Write one short sentence noting that the draft was prepared and which branch was picked. Example: \"Draft missing-package reply prepared (branch A: marked delivered); awaiting human approval.\"",
    "",
    "Hard rules:",
    "- Never call any tool other than `shopify.get_order`, `shopify.get_customer`, `case.update_context`, or `conversation.reply`.",
    "- Never call `shopify.get_order` more than once per case.",
    "- Never call `conversation.reply` more than once per case.",
    "- Never call `refund.create` — refunds for missing packages go through the refund-review-agent after the customer confirms they want one.",
    "- Never call `agent.handoff` — there is no further agent to hand off to.",
    "- If `shopify.get_order` returns an `OrderNotFound`-style error, do NOT retry. Skip `conversation.reply` and respond with plain text apologising that the order id could not be located and asking the customer to confirm it.",
    "- Treat a successful `conversation.reply` as terminal. Do not call any other action after it.",
  ].join("\n"),
  // shopify.get_customer is listed but optional — the customer-ID stamp
  // at case-create time already lands customerEmail + shopifyCustomerId
  // on the case context for most inbound messages. Keeps the agent's
  // surface consistent with refund-review-agent.
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
