// Plain-language copy for the resolution-policy editor — the merchant never sees
// a tool id. The `tool` values map 1:1 to the runtime's remedy tools
// (SCENARIO_REMEDY_TOOLS); fulfillment partner handling is the radio (fulfillmentOperatorMode), not a
// checklist action. The NAME of an action comes from TOOL_DISPLAY_NAMES, so the
// checkbox here, the `/` chip in a playbook, and the ticket timeline all call it
// the same thing; only the `help` line is local to this screen.

import { toolDisplayName } from "@support-agent/agent-core";

export interface RemedyAction {
  readonly tool: string;
  readonly label: string;
  readonly help: string;
}

const remedy = (tool: string, help: string): RemedyAction => ({
  tool,
  label: toolDisplayName(tool),
  help,
});

export const REMEDY_ACTIONS: ReadonlyArray<RemedyAction> = [
  remedy(
    "refund.create",
    "Refund the customer, still capped by your Refund policy.",
  ),
  remedy(
    "discount.create",
    "A single-use coupon locked to the customer, capped by your Discount policy.",
  ),
  remedy(
    "order.cancel",
    "Cancel an unshipped order and refund it, governed by your Refund policy.",
  ),
  remedy(
    "order.update_shipping_address",
    "Change the delivery address on an order that hasn't shipped yet.",
  ),
];

/** Gated by the fulfillment partner radio, not by the action checklist. */
export const FULFILLMENT_OPERATOR_ESCALATE_TOOL = "fulfillment_operator.escalate";

/**
 * The actions this scenario will NOT let the agent take — mirrors the runtime's
 * `applyScenarioEnvelope`, which strips exactly these from the tool schema and
 * denies them. Everything else the agent has (reading an order, searching the
 * knowledge base, asking the customer, replying) is baseline and always on, so
 * it never appears here.
 *
 * Used to warn a merchant whose playbook prose tells the agent to do something
 * their own switches forbid — the soft layer quietly contradicting the hard gate.
 */
export const deniedActionsFor = (
  enabledTools: ReadonlySet<string>,
  fulfillmentOperatorMode: string,
): ReadonlySet<string> => {
  const denied = new Set(
    REMEDY_ACTIONS.map((a) => a.tool).filter((t) => !enabledTools.has(t)),
  );
  if (fulfillmentOperatorMode === "none") denied.add(FULFILLMENT_OPERATOR_ESCALATE_TOOL);
  return denied;
};

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
