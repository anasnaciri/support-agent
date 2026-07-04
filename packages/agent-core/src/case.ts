import type {
  AgentId,
  CaseId,
  CustomerId,
  OrderId,
  TenantId,
  ThreadId,
} from "./ids.js";
import type { ProposedAction } from "./payloads.js";

export type CaseStatus =
  | "new"
  | "triaging"
  | "in_progress"
  | "waiting_for_customer"
  | "waiting_for_supplier"
  | "waiting_for_approval"
  | "approved_action_running"
  | "resolved"
  | "archived"
  | "failed"
  | "human_takeover";

export const CASE_STATUSES: ReadonlyArray<CaseStatus> = [
  "new",
  "triaging",
  "in_progress",
  "waiting_for_customer",
  "waiting_for_supplier",
  "waiting_for_approval",
  "approved_action_running",
  "resolved",
  "archived",
  "failed",
  "human_takeover",
];

/**
 * Case state machine (master-plan §10, audit L1). Same-status writes are
 * always allowed (idempotent). Active statuses move freely — the agent
 * loop owns them. The constrained states:
 *
 *   - `human_takeover`: a PERSON owns the conversation. Only an explicit
 *     resume (→ in_progress) or an administrative close (→ failed) exits;
 *     in particular the runtime must never resolve or re-park a case a
 *     manager just claimed (the final_message-over-takeover race).
   *   - `resolved`: may reopen (a customer replying on the thread re-enters
   *     the loop) or move to retention-owned `archived`, but never flips to
   *     `failed`.
   *   - `archived`: may reopen from a customer reply; otherwise it stays parked
   *     until the retention sweep deletes it.
 *   - `failed`: reopen or hand to a human only.
 */
const RESTRICTED_TRANSITIONS: Partial<
  Record<CaseStatus, ReadonlyArray<CaseStatus>>
> = {
  human_takeover: ["in_progress", "failed"],
  resolved: [
    "in_progress",
    "triaging",
    "waiting_for_approval",
    "waiting_for_customer",
    "waiting_for_supplier",
    "human_takeover",
    "archived",
  ],
  archived: [
    "in_progress",
    "triaging",
    "waiting_for_approval",
    "waiting_for_customer",
    "waiting_for_supplier",
    "human_takeover",
  ],
  failed: ["in_progress", "triaging", "human_takeover"],
};

export const isStatusTransitionAllowed = (
  from: CaseStatus,
  to: CaseStatus,
): boolean => {
  if (from === to) return true;
  const allowed = RESTRICTED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : true;
};

/**
 * The statuses a human may set BY HAND from the dashboard ("change status
 * manually"). A curated subset of CASE_STATUSES: the agent-internal lifecycle
 * states (`new`, `triaging`, `approved_action_running`) and the
 * machinery-driven parks (`waiting_for_supplier` needs an escalation row;
 * `waiting_for_approval` needs a pending approval; `human_takeover` has its own
 * "Take over" action) are deliberately NOT offered — a person doesn't drive
 * those directly. Picking one of these is still re-checked against
 * `isStatusTransitionAllowed`, so the manual control never bypasses §10.
 */
export const MERCHANT_SETTABLE_STATUSES: ReadonlyArray<CaseStatus> = [
  "in_progress",
  "waiting_for_customer",
  "resolved",
  "failed",
];

const MERCHANT_SETTABLE_SET: ReadonlySet<string> = new Set(
  MERCHANT_SETTABLE_STATUSES,
);

/** Whether `status` is one a merchant may set by hand (narrows to CaseStatus). */
export const isMerchantSettableStatus = (status: string): status is CaseStatus =>
  MERCHANT_SETTABLE_SET.has(status);

/**
 * The statuses a merchant may manually move a case to FROM `from`: the
 * merchant-settable statuses that are also a legal transition under the state
 * machine, excluding `from` itself. The dashboard renders exactly this set as
 * the "change status" options, so the UI can never offer an illegal move.
 */
export const allowedManualStatusTargets = (
  from: CaseStatus,
): ReadonlyArray<CaseStatus> =>
  MERCHANT_SETTABLE_STATUSES.filter(
    (to) => to !== from && isStatusTransitionAllowed(from, to),
  );

export type WaitStatus = Extract<
  CaseStatus,
  "waiting_for_approval" | "waiting_for_supplier"
>;

/**
 * A case can be waiting on approval AND on a supplier at once — both facts are
 * row-derived (pending approval rows, open escalation rows), but the single
 * `cases.status` carries the PRIMARY wait: approval wins because the merchant
 * is the next unblocker, while the supplier wait is passive (the open
 * escalation row + notify outbox carry it independently of status). Every
 * site that must choose between the two parks calls this, so the precedence
 * lives in exactly one place. Null = not waiting on either.
 */
export const primaryWaitStatus = (waits: {
  readonly approvalPending: boolean;
  readonly supplierOpen: boolean;
}): WaitStatus | null =>
  waits.approvalPending
    ? "waiting_for_approval"
    : waits.supplierOpen
      ? "waiting_for_supplier"
      : null;

export type CasePriority = "low" | "normal" | "high" | "urgent";

export type CaseChannel = "email" | "form" | "chat" | "api";

export interface CaseContext {
  readonly identifiedCustomerId?: CustomerId;
  /**
   * Canonical "which order is this case about" pointer — ALWAYS a stable Shopify
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

export interface Case {
  readonly id: CaseId;
  readonly tenantId: TenantId;
  readonly customerId: CustomerId | null;
  readonly orderId: OrderId | null;
  readonly channel: CaseChannel;
  readonly threadId: ThreadId | null;
  /** Connected conversation mailbox that owns `threadId`. */
  readonly mailbox: string | null;
  readonly category: string | null;
  readonly status: CaseStatus;
  readonly currentAgentId: AgentId;
  readonly priority: CasePriority;
  readonly summary: string | null;
  readonly subject: string | null;
  readonly context: CaseContext;
  /**
   * Per-case "round" counter (defaults to 0). Bumped on every resume/takeover;
   * approvals and events created in a prior round (a lower epoch) are stale and
   * must not act on the current round. Recovery hardening.
   */
  readonly epoch?: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
  readonly archivedAt?: Date | null;
}
