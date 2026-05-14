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
