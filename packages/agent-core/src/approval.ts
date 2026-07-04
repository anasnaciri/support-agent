import type {
  AgentId,
  ApprovalId,
  TicketId,
  TenantId,
  UserId,
} from "./ids.js";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";

export interface Approval {
  readonly id: ApprovalId;
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  readonly agentId: AgentId;
  readonly tool: string;
  readonly proposedInput: unknown;
  readonly approvedInput: unknown | null;
  readonly reasoning: string;
  readonly riskLevel: ApprovalRiskLevel;
  readonly status: ApprovalStatus;
  readonly decidedBy: UserId | null;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  /** The ticket round (`Ticket.epoch`) this approval was created in (defaults 0). */
  readonly epoch?: number;
  /**
   * Set once the decision has been ACTED ON — executed, deduped, or skipped.
   * A resumed approval is never re-run by a later bundle nor re-published by the
   * maintenance sweep. Recovery hardening.
   */
  readonly resumedAt?: Date | null;
}
