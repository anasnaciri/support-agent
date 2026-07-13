// Merchant-facing labels for the raw enums and dotted ids the api returns.
// Nothing snake_case or code-flavored may reach the UI: every helper maps the
// known values explicitly and humanizes unknown ones, so a newly-added
// backend code still renders as words while it waits for a real label.

import { TOOL_DISPLAY_NAMES } from "@support-agent/agent-core";

/** "where_is_order" / "ticket.escalated_to_human" → "Where is order" / "Ticket escalated to human". */
export const humanizeSlug = (value: string): string => {
  const words = value.replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const TICKET_STATUS_LABELS: Readonly<Record<string, string>> = {
  new: "New",
  triaging: "Reviewing",
  in_progress: "In progress",
  waiting_for_customer: "Waiting on customer",
  waiting_for_fulfillment_operator: "Waiting on fulfillment partner",
  waiting_for_approval: "Needs approval",
  approved_action_running: "Finishing approved action",
  resolved: "Resolved",
  archived: "Archived",
  failed: "Failed",
  human_takeover: "With you",
};

export const ticketStatusLabel = (status: string): string =>
  TICKET_STATUS_LABELS[status] ?? humanizeSlug(status);

/**
 * True when a ticket actually carries a subject. A `??` fallback only caught
 * null/undefined — an empty or whitespace-only Subject header (which inbound
 * email can produce) slipped through and rendered as a blank, awkward row.
 */
export const hasSubject = (subject: string | null | undefined): boolean =>
  (subject ?? "").trim().length > 0;

/** A ticket's subject for display: trimmed, or "(No subject)" when there is none. */
export const ticketSubjectLabel = (subject: string | null | undefined): string => {
  const trimmed = (subject ?? "").trim();
  return trimmed.length > 0 ? trimmed : "(No subject)";
};

/** The ticket statuses offered by the tickets-list status filter, in display
 *  order — derived from the canonical label map so the picker never drifts. */
export const ticketStatusFilterOptions: ReadonlyArray<{
  readonly label: string;
  readonly value: string;
}> = Object.entries(TICKET_STATUS_LABELS).map(([value, label]) => ({
  value,
  label,
}));

export const approvalStatusLabel = (status: string): string =>
  humanizeSlug(status);

/**
 * Friendly names for tool ids shown on approvals / the timeline. The map IS
 * `TOOL_DISPLAY_NAMES` from agent-core — the same source `defineTool` stamps
 * onto every tool and the catalog ships as `displayName` — so this surface
 * can't drift from the agent-settings card or the Telegram pings. The
 * fallback drops the namespace so even an unmapped tool reads as an action,
 * not an identifier.
 */
export const toolActionLabel = (tool: string): string => {
  const known = TOOL_DISPLAY_NAMES[tool];
  if (known) return known;
  const dot = tool.lastIndexOf(".");
  return humanizeSlug(dot === -1 ? tool : tool.slice(dot + 1));
};

// Friendly copy for the custom-agent save error codes the api returns. The
// `detail` (a tool name / provider:scope) is appended by the caller when set.
const CUSTOM_AGENT_ERROR_LABELS: Readonly<Record<string, string>> = {
  name_required: "Give your agent a name.",
  name_too_long: "That name is too long.",
  description_required: "Add a short description.",
  description_too_long: "That description is too long.",
  instructions_required: "Add instructions for your agent.",
  instructions_too_long: "Those instructions are too long.",
  model_required: "Pick a model.",
  invalid_tool: "One of the selected actions can't be assigned.",
  invalid_handoff: "One of the handoff targets isn't a valid agent.",
  self_handoff: "An agent can't hand off to itself.",
  invalid_callable_from: "One of the routing sources isn't a valid agent.",
  missing_connector_scope:
    "An action needs a connection you haven't set up yet.",
  invalid_permission: "An approval setting is invalid.",
  invalid_status: "That status isn't allowed.",
  duplicate_name: "You already have an agent with that name.",
  not_found: "That agent no longer exists.",
};

export const customAgentErrorLabel = (code: string): string =>
  CUSTOM_AGENT_ERROR_LABELS[code] ?? "Couldn't save the agent. Check the fields and try again.";

const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  "event.received": "Message received",
  "tool.invoked": "Action taken",
  "llm.decision": "Agent decision",
  "ticket.created": "Ticket opened",
  "ticket.resolved": "Ticket resolved",
  "ticket.escalated_to_human": "Escalated to you",
  "ticket.taken_over": "You took over",
  "ticket.handed_back": "Handed back to agent",
  "ticket.status_changed": "Status updated",
  "ticket.refund_issued": "Refund issued",
  "ticket.order_cancelled": "Order cancelled",
  "approval.requested": "Approval requested",
  "approval.decided": "Approval decided",
};

export const auditActionLabel = (action: string): string => {
  if (action.startsWith("compliance.")) return "Data & privacy request";
  return AUDIT_ACTION_LABELS[action] ?? humanizeSlug(action);
};
