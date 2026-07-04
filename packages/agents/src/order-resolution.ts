/**
 * Shared prompt block for the order-handling specialists (order-status,
 * refund-review, missing-package, damaged-product). Each of them needs to
 * land on a single concrete order before doing its category-specific work,
 * and they all resolve it the same way:
 *
 *   - the ticket already has a runtime-identified order (a stable GID) → load it
 *     with `shopify.get_order` and stop; or
 *   - the customer quoted an order ref (`quotedOrderRef`, recorded by triage) →
 *     try it with `shopify.get_order`; or
 *   - no ref, OR the quoted ref didn't resolve (mistyped/foreign code) → look
 *     up the customer's orders by the email they wrote from. Exactly one order
 *     means we KNOW which order they mean, so we use it instead of bothering
 *     them for an order number; zero or many means we still have to ask.
 *
 * Keeping this in one place means the four specialists behave identically
 * here (and there's one block to fix if the policy changes). Spread it into
 * a prompt's line array. Every agent that uses it MUST grant both
 * `shopify.get_order` and `shopify.find_customer_order`, plus
 * `conversation.ask_customer` for the zero/many paths.
 */
export const ORDER_RESOLUTION_LINES: ReadonlyArray<string> = [
  "OBTAIN THE ORDER — do this before anything that needs order details:",
  "  - If a runtime note says this ticket ALREADY has an identified order (a line like `[This ticket already has an identified order: gid://shopify/Order/...]`), call `shopify.get_order` ONCE with exactly that GID and use what it returns. That IS the order this ticket is about — do NOT search again by anything the customer quoted.",
  "  - Otherwise, if the ticket context carries a `quotedOrderRef` (the order number / confirmation code the customer gave, recorded by the prior `ticket.update_context` tool result) OR the customer clearly stated an order number in their message, call `shopify.get_order` ONCE with that value. It may be an order name (`#1001`), a confirmation number (`XPAV284CT`), a numeric id, or a `gid://shopify/Order/...` GID — pass it through unchanged. If it RESOLVES, use that order.",
  "  - If there is NO order reference anywhere, OR `shopify.get_order` came back not-found for the customer's quoted reference (their code may be mistyped or from a different system), do NOT tell the customer you can't find their order yet. Instead call `shopify.find_customer_order` ONCE with `email` set to the customer's address from the `[Thread context: ...]` header, then branch on the result's `status`:",
  "      - `single`: the customer has exactly one order, returned as `order`. Use it as the order this ticket is about — do NOT ask them for an order number. It was looked up by their own email, so their identity is already established; skip any identity check.",
  "      - `multiple`: call `conversation.ask_customer` ONCE asking which order they mean (their order number, or the confirmation code from their order email). Do nothing else this turn — the ticket parks until they reply.",
  "      - `none`: call `conversation.ask_customer` ONCE asking for the order number / confirmation code from their order email so you can locate it. Do nothing else this turn — the ticket parks until they reply.",
  '  - Refer to whichever order you obtain as "the order" below. Call `shopify.get_order` and `shopify.find_customer_order` at most once each per ticket (a get_order miss followed by one find_customer_order fallback is fine).',
];
