import type { CustomerId, OrderId, ThreadId } from "./ids.js";

/**
 * Inbound customer message normalised by a connector. The event
 * `message.received` carries this as its payload.
 *
 * Shape is intentionally provider-neutral — Gmail, Outlook, IMAP, and
 * helpdesk-style connectors all map their wire formats onto this. The
 * agent runtime and tools never reach behind it.
 *
 * Distinct from `ConversationMessage` (which carries a `direction` field
 * for thread history) because at the event boundary direction is always
 * "inbound" — narrowing it here keeps route handlers honest.
 */
export interface InboundMessage {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly from: { readonly name: string | null; readonly email: string };
  readonly to: ReadonlyArray<{ readonly name: string | null; readonly email: string }>;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly receivedAt: Date;
  readonly attachments: ReadonlyArray<MessageAttachment>;
}

/**
 * Provider-neutral outbound draft. The `wait_for_customer` LLM decision
 * carries this; tools that send replies also accept this shape (or its
 * dedicated tool-input variants).
 */
export interface OutboundMessageDraft {
  readonly threadId: ThreadId | null;
  readonly to: ReadonlyArray<{ readonly name: string | null; readonly email: string }>;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly attachments: ReadonlyArray<MessageAttachment>;
}

export interface MessageAttachment {
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
