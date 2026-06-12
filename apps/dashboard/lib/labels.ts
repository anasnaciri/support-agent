// Merchant-facing labels for the raw enums and dotted ids the api returns.
// Nothing snake_case or code-flavored may reach the UI: every helper maps the
// known values explicitly and humanizes unknown ones, so a newly-added
// backend code still renders as words while it waits for a real label.

/** "where_is_order" / "case.escalated_to_human" → "Where is order" / "Case escalated to human". */
export const humanizeSlug = (value: string): string => {
  const words = value.replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const CASE_STATUS_LABELS: Readonly<Record<string, string>> = {
  new: "New",
  triaging: "Reviewing",
  in_progress: "In progress",
  waiting_for_customer: "Waiting on customer",
  waiting_for_supplier: "Waiting on supplier",
  waiting_for_approval: "Needs approval",
  approved_action_running: "Finishing approved action",
  resolved: "Resolved",
  failed: "Failed",
  human_takeover: "With you",
};

export const caseStatusLabel = (status: string): string =>
  CASE_STATUS_LABELS[status] ?? humanizeSlug(status);

export const approvalStatusLabel = (status: string): string =>
  humanizeSlug(status);

/**
 * Friendly names for tool ids shown on approvals. Mirrors each tool's
 * catalog `displayName` (packages/tools) — keep them in sync when a gated
 * tool is added or renamed. The fallback drops the namespace so even an
 * unmapped tool reads as an action, not an identifier.
 */
const TOOL_ACTION_LABELS: Readonly<Record<string, string>> = {
  "conversation.reply": "Send customer reply",
  "conversation.ask_customer": "Ask the customer a question",
  "refund.create": "Issue a refund",
  "supplier.add_sheet_row": "Escalate to supplier",
  "merchant.notify": "Send you a heads-up",
};

export const toolActionLabel = (tool: string): string => {
  const known = TOOL_ACTION_LABELS[tool];
  if (known) return known;
  const dot = tool.lastIndexOf(".");
  return humanizeSlug(dot === -1 ? tool : tool.slice(dot + 1));
};

const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  "event.received": "Message received",
  "tool.invoked": "Action taken",
  "llm.decision": "Agent decision",
  "case.created": "Case opened",
  "case.resolved": "Case resolved",
  "case.escalated_to_human": "Escalated to you",
  "case.taken_over": "You took over",
  "case.handed_back": "Handed back to agent",
  "approval.requested": "Approval requested",
  "approval.decided": "Approval decided",
};

export const auditActionLabel = (action: string): string => {
  if (action.startsWith("compliance.")) return "Data & privacy request";
  return AUDIT_ACTION_LABELS[action] ?? humanizeSlug(action);
};
