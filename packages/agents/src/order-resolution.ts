/**
 * Shared prompt block for the order-handling specialists (order-status,
 * refund-review, missing-package, damaged-product). Each of them needs to
 * land on a single concrete order before doing its category-specific work,
 * and they all resolve it the same way:
 *
 *   - an order id is on the case (triage extracted it from the message) →
 *     look it up with `shopify.get_order`; or
 *   - no order id → look up the customer's orders by the email they wrote
 *     from. Exactly one order means we KNOW which order they mean, so we use
 *     it instead of bothering them for an order number; zero or many means
 *     we still have to ask.
 *
 * Keeping this in one place means the four specialists behave identically
 * here (and there's one block to fix if the policy changes). Spread it into
 * a prompt's line array. Every agent that uses it MUST grant both
 * `shopify.get_order` and `shopify.find_customer_order`, plus
 * `conversation.ask_customer` for the zero/many paths.
 */
export const ORDER_RESOLUTION_LINES: ReadonlyArray<string> = [
  "OBTAIN THE ORDER — do this before anything that needs order details:",
  "  - If the case context carries an `identifiedOrderId` (from the prior `case.update_context` tool result) OR the customer clearly stated an order number in their message, call `shopify.get_order` ONCE with that value. It may be an order name (`#1001`), a confirmation number (`XPAV284CT`), a numeric id, or a `gid://shopify/Order/...` GID — pass it through unchanged; the tool resolves all of these.",
  "  - If there is NO order id anywhere, do NOT ask the customer for an order number yet. Call `shopify.find_customer_order` ONCE with `email` set to the customer's address from the `[Thread context: ...]` header, then branch on the result's `status`:",
  "      - `single`: the customer has exactly one order, returned as `order`. Use it as the order this case is about — do NOT ask them for an order number. It was looked up by their own email, so their identity is already established; skip any identity check.",
  "      - `multiple`: call `conversation.ask_customer` ONCE asking which order they mean (their order number, or the confirmation code from their order email). Do nothing else this turn — the case parks until they reply.",
  "      - `none`: call `conversation.ask_customer` ONCE asking for the order number / confirmation code from their order email so you can locate it. Do nothing else this turn — the case parks until they reply.",
  '  - Refer to whichever order you obtain as "the order" below. Never call `shopify.get_order` or `shopify.find_customer_order` more than once each per case.',
];
