import type { CustomerId, OrderId, ThreadId } from "./ids.js";

export interface InboundEmail {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly from: { readonly name: string | null; readonly email: string };
  readonly to: ReadonlyArray<{ readonly name: string | null; readonly email: string }>;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly receivedAt: Date;
  readonly attachments: ReadonlyArray<EmailAttachment>;
}

export interface OutboundEmailDraft {
  readonly threadId: ThreadId | null;
  readonly to: ReadonlyArray<{ readonly name: string | null; readonly email: string }>;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly attachments: ReadonlyArray<EmailAttachment>;
}

export interface EmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
}

export interface TicketInput {
  readonly subject: string;
  readonly body: string;
  readonly customerEmail: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SupplierUpdate {
  readonly supplierId: string;
  readonly note: string;
  readonly proposedResolution: string | null;
}

export interface SupplierEscalationPayload {
  readonly supplierId: string;
  readonly orderId: OrderId;
  readonly customerId: CustomerId | null;
  readonly reason: string;
  readonly evidence: ReadonlyArray<string>;
}

export interface TrackingEvent {
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly status: string;
  readonly occurredAt: Date;
  readonly location: string | null;
}

export interface ProposedAction {
  readonly tool: string;
  readonly input: unknown;
  readonly reasoning: string;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
}
