// Plain-language labels for the resolution-policy editor — the merchant never
// sees a tool id. The `tool` values map 1:1 to the runtime's remedy tools
// (SCENARIO_REMEDY_TOOLS); fulfillment partner handling is the radio (fulfillmentOperatorMode), not a
// checklist action.

export interface RemedyAction {
  readonly tool: string;
  readonly label: string;
  readonly help: string;
}

export const REMEDY_ACTIONS: ReadonlyArray<RemedyAction> = [
  {
    tool: "refund.create",
    label: "Issue a refund",
    help: "Refund the customer — still capped by your Refund policy.",
  },
  {
    tool: "discount.create",
    label: "Offer a discount coupon",
    help: "A single-use coupon locked to the customer — capped by your Discount policy.",
  },
  {
    tool: "order.cancel",
    label: "Cancel the order",
    help: "Cancel an unshipped order and refund it — governed by your Refund policy.",
  },
];

export interface FulfillmentOperatorModeOption {
  readonly value: "escalate_and_wait" | "notify_and_proceed" | "none";
  readonly label: string;
  readonly help: string;
}

export const FULFILLMENT_OPERATOR_MODE_OPTIONS: ReadonlyArray<FulfillmentOperatorModeOption> = [
  {
    value: "escalate_and_wait",
    label: "Escalate to my fulfillment partner and wait",
    help: "Loop the fulfillment partner in and pause the ticket until they respond.",
  },
  {
    value: "notify_and_proceed",
    label: "Notify my fulfillment partner and keep helping",
    help: "Tell the fulfillment partner, but resolve for the customer now.",
  },
  {
    value: "none",
    label: "Don't involve a fulfillment partner",
    help: "Handle it between the store and the customer.",
  },
];

export interface PermissionOption {
  readonly value: "ask" | "allow";
  readonly label: string;
}

export const PERMISSION_OPTIONS: ReadonlyArray<PermissionOption> = [
  { value: "ask", label: "Ask me first" },
  { value: "allow", label: "Do it automatically" },
];
