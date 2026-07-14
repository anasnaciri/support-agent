import type {
  AgentId,
  TicketId,
  CustomerId,
  OrderId,
  TenantId,
  ThreadId,
} from "./ids.js";
import type { ProposedAction } from "./payloads.js";

export type TicketStatus =
  | "new"
  | "triaging"
  | "in_progress"
  | "waiting_for_customer"
  | "waiting_for_fulfillment_operator"
  | "waiting_for_approval"
  | "approved_action_running"
  | "resolved"
  | "archived"
  | "failed"
  | "human_takeover";

export const TICKET_STATUSES: ReadonlyArray<TicketStatus> = [
  "new",
  "triaging",
  "in_progress",
  "waiting_for_customer",
  "waiting_for_fulfillment_operator",
  "waiting_for_approval",
  "approved_action_running",
  "resolved",
  "archived",
  "failed",
  "human_takeover",
];

/**
 * Ticket state machine (master-plan §10, audit L1). Same-status writes are
 * always allowed (idempotent). Active statuses move freely — the agent
 * loop owns them. The constrained states:
 *
 *   - `human_takeover`: a PERSON owns the conversation. Only an explicit
 *     resume (→ in_progress) or an administrative close (→ failed) exits;
 *     in particular the runtime must never resolve or re-park a ticket a
 *     manager just claimed (the final_message-over-takeover race).
   *   - `resolved`: may reopen (a customer replying on the thread re-enters
   *     the loop) or move to retention-owned `archived`, but never flips to
   *     `failed`.
   *   - `archived`: may reopen from a customer reply; otherwise it stays parked
   *     until the retention sweep deletes it. Entry is restricted too: only a
   *     `resolved` ticket may be archived — retention is strictly
   *     post-resolution, whether the sweep or a person triggers it.
 *   - `failed`: reopen (to the agent loop, or parked waiting on the
 *     customer's next message) or hand to a human only.
 */
const RESTRICTED_TRANSITIONS: Partial<
  Record<TicketStatus, ReadonlyArray<TicketStatus>>
> = {
  human_takeover: ["in_progress", "failed"],
  resolved: [
    "in_progress",
    "triaging",
    "waiting_for_approval",
    "waiting_for_customer",
    "waiting_for_fulfillment_operator",
    "human_takeover",
    "archived",
  ],
  archived: [
    "in_progress",
    "triaging",
    "waiting_for_approval",
    "waiting_for_customer",
    "waiting_for_fulfillment_operator",
    "human_takeover",
  ],
  failed: ["in_progress", "triaging", "waiting_for_customer", "human_takeover"],
};

export const isStatusTransitionAllowed = (
  from: TicketStatus,
  to: TicketStatus,
): boolean => {
  if (from === to) return true;
  // `archived` is entry-restricted, not just exit-restricted: live statuses
  // move freely otherwise, but none of them may skip straight to archived.
  if (to === "archived" && from !== "resolved") return false;
  const allowed = RESTRICTED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : true;
};

/**
 * The statuses a human may set BY HAND from the dashboard ("change status
 * manually"). A curated subset of TICKET_STATUSES: the agent-internal lifecycle
 * states (`new`, `triaging`, `in_progress`, `approved_action_running`) and the
 * machinery-driven parks (`waiting_for_fulfillment_operator` needs an escalation row;
 * `waiting_for_approval` needs a pending approval; `human_takeover` has its own
 * "Take over" action) are deliberately NOT offered — a person doesn't drive
 * those directly. `in_progress` in particular: a manual status write never
 * ticks the agent, so a hand-set in_progress would only fake the dashboard's
 * "processing" treatment — reopening a closed ticket lands on
 * `waiting_for_customer` (the agent runs on the customer's next message), and
 * "Retry" is the control that actually runs the agent. Picking one of these
 * is still re-checked against `isStatusTransitionAllowed`, so the manual
 * control never bypasses §10 — `archived` in particular is only ever offered
 * on a `resolved` ticket ("Archive now" skips the 30-day retention wait;
 * deletion still happens 12 months after `archivedAt`).
 */
export const MERCHANT_SETTABLE_STATUSES: ReadonlyArray<TicketStatus> = [
  "waiting_for_customer",
  "resolved",
  "archived",
  "failed",
];

const MERCHANT_SETTABLE_SET: ReadonlySet<string> = new Set(
  MERCHANT_SETTABLE_STATUSES,
);

/** Whether `status` is one a merchant may set by hand (narrows to TicketStatus). */
export const isMerchantSettableStatus = (status: string): status is TicketStatus =>
  MERCHANT_SETTABLE_SET.has(status);

/**
 * The statuses a merchant may manually move a ticket to FROM `from`: the
 * merchant-settable statuses that are also a legal transition under the state
 * machine, excluding `from` itself. The dashboard renders exactly this set as
 * the "change status" options, so the UI can never offer an illegal move.
 */
export const allowedManualStatusTargets = (
  from: TicketStatus,
): ReadonlyArray<TicketStatus> =>
  MERCHANT_SETTABLE_STATUSES.filter(
    (to) => to !== from && isStatusTransitionAllowed(from, to),
  );

export type WaitStatus = Extract<
  TicketStatus,
  "waiting_for_approval" | "waiting_for_fulfillment_operator"
>;

/**
 * A ticket can be waiting on approval AND on a fulfillment partner at once — both facts are
 * row-derived (pending approval rows, open escalation rows), but the single
 * `tickets.status` carries the PRIMARY wait: approval wins because the merchant
 * is the next unblocker, while the fulfillment partner wait is passive (the open
 * escalation row + notify outbox carry it independently of status). Every
 * site that must choose between the two parks calls this, so the precedence
 * lives in exactly one place. Null = not waiting on either.
 */
export const primaryWaitStatus = (waits: {
  readonly approvalPending: boolean;
  readonly fulfillmentOperatorOpen: boolean;
}): WaitStatus | null =>
  waits.approvalPending
    ? "waiting_for_approval"
    : waits.fulfillmentOperatorOpen
      ? "waiting_for_fulfillment_operator"
      : null;

export type TicketPriority = "low" | "normal" | "high" | "urgent";

export type TicketChannel = "email" | "form" | "chat" | "api";

export interface TicketContext {
  readonly identifiedCustomerId?: CustomerId;
  /**
   * Canonical "which order is this ticket about" pointer — ALWAYS a stable Shopify
   * GID, stamped by the runtime only after an order tool resolves the order.
   * Every consumer (agent bound-order directive, dashboard order panel, refund
   * button) re-resolves it exactly via `getOrder(gid)`. Never holds a fuzzy
   * name/confirmation code — that lives in {@link quotedOrderRef}.
   */
  readonly identifiedOrderId?: OrderId;
  /**
   * The customer's QUOTED order reference (untrusted hint) — a name like `#1001`
   * or a confirmation code like `XPAV284CT`, recorded verbatim by triage. Drives
   * a specialist's first `shopify.get_order` lookup; superseded by the resolved
   * GID in {@link identifiedOrderId} once an order tool actually finds the order.
   */
  readonly quotedOrderRef?: string;
  readonly classification?: string;
  readonly evidenceIds?: ReadonlyArray<string>;
  readonly proposedActions?: ReadonlyArray<ProposedAction>;
  readonly [key: string]: unknown;
}

export interface Ticket {
  readonly id: TicketId;
  readonly tenantId: TenantId;
  readonly customerId: CustomerId | null;
  readonly orderId: OrderId | null;
  readonly channel: TicketChannel;
  readonly threadId: ThreadId | null;
  /** Connected conversation mailbox that owns `threadId`. */
  readonly mailbox: string | null;
  readonly status: TicketStatus;
  readonly currentAgentId: AgentId;
  readonly priority: TicketPriority;
  readonly summary: string | null;
  readonly subject: string | null;
  readonly context: TicketContext;
  /**
   * Per-ticket "round" counter (defaults to 0). Bumped on every resume/takeover;
   * approvals and events created in a prior round (a lower epoch) are stale and
   * must not act on the current round. Recovery hardening.
   */
  readonly epoch?: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
  readonly archivedAt?: Date | null;
}
