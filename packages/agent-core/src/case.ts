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
 *     the loop) but never flips to `failed`.
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

export type CasePriority = "low" | "normal" | "high" | "urgent";

export type CaseChannel = "email" | "form" | "chat" | "api";

export interface CaseContext {
  readonly identifiedCustomerId?: CustomerId;
  readonly identifiedOrderId?: OrderId;
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
  readonly category: string | null;
  readonly status: CaseStatus;
  readonly currentAgentId: AgentId;
  readonly priority: CasePriority;
  readonly summary: string | null;
  readonly subject: string | null;
  readonly context: CaseContext;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
}
