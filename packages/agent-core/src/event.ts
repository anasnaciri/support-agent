import type {
  ApprovalId,
  CaseId,
  OrderId,
  TenantId,
  ThreadId,
  UserId,
} from "./ids.js";
import type {
  InboundMessage,
  SupplierUpdate,
  TicketInput,
  TrackingEvent,
} from "./payloads.js";

export type DomainEvent =
  | {
      readonly type: "message.received";
      readonly tenantId: TenantId;
      readonly threadId: ThreadId;
      readonly payload: InboundMessage;
    }
  | {
      readonly type: "customer.replied";
      readonly caseId: CaseId;
      readonly payload: InboundMessage;
    }
  | {
      readonly type: "ticket.created";
      readonly tenantId: TenantId;
      readonly source: "form" | "chat" | "api";
      readonly payload: TicketInput;
    }
  | {
      readonly type: "approval.approved";
      readonly approvalId: ApprovalId;
      readonly caseId: CaseId;
      readonly managerId: UserId;
      readonly edits?: unknown;
    }
  | {
      readonly type: "approval.rejected";
      readonly approvalId: ApprovalId;
      readonly caseId: CaseId;
      readonly managerId: UserId;
      readonly reason?: string;
    }
  | {
      readonly type: "supplier.updated";
      readonly caseId: CaseId;
      readonly payload: SupplierUpdate;
    }
  | {
      readonly type: "tracking.changed";
      readonly orderId: OrderId;
      readonly payload: TrackingEvent;
    }
  | {
      readonly type: "timer.expired";
      readonly caseId: CaseId;
      readonly timerId: string;
      readonly reason: "follow_up" | "sla" | "escalation";
    }
  | {
      readonly type: "manual.takeover";
      readonly caseId: CaseId;
      readonly managerId: UserId;
    }
  | {
      readonly type: "case.resumed";
      readonly caseId: CaseId;
      readonly trigger: string;
      /**
       * Unique per manager-initiated restart, stable across pg-boss
       * redeliveries of the SAME job. Scopes the tool-execution dedup
       * (`deliveryScopeFor`) so a fresh retry re-runs the agent's tools — a
       * stable-`draftId` reply/ask is no longer deduped against the PRIOR
       * attempt — while a redelivery of one retry still can't double-send.
       * Optional for back-compat (older events / non-retry resumes).
       */
      readonly resumeToken?: string;
    };

export type DomainEventType = DomainEvent["type"];
