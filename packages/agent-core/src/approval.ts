import type {
  AgentId,
  ApprovalId,
  CaseId,
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
  readonly caseId: CaseId;
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
}
