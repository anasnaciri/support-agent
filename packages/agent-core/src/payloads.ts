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

/**
 * Normalised state from a tracking provider — discriminated union so
 * the tool boundary can express both "we have live data" and "we have
 * no upstream provider configured" without conflating them with an
 * Effect failure.
 *
 * `kind: "live"` — an upstream provider (17track today) returned data.
 *   `status` is the coarse delivery state derived from the provider's
 *   carrier-specific events. `lastScan` is the most recent carrier
 *   event (may be null if the provider hasn't seen any events yet).
 *
 * `kind: "no_provider"` — the platform has no upstream provider wired
 *   up (env unset) OR the active provider doesn't cover this carrier.
 *   The tool still returns a useful answer: the bare tracking number
 *   plus a public tracking URL the customer can follow. Agent prompts
 *   branch on `kind` to decide what to put in the reply.
 *
 * `trackingUrl` is always populated. For `live`, it points at the
 * provider's deep link when available, otherwise a generic public
 * lookup. For `no_provider`, it points at 17track's public web page
 * (https://t.17track.net/en#nums=<num>) — that page accepts bare
 * tracking numbers and auto-detects the carrier client-side.
 */
export type TrackingStatus =
  | "in_transit"
  | "delivered"
  | "exception"
  | "pending"
  | "unknown";

export interface TrackingScanEvent {
  readonly occurredAt: Date;
  readonly location: string | null;
  readonly description: string;
}

export type TrackingLookup =
  | {
      readonly kind: "live";
      readonly carrier: string;
      readonly trackingNumber: string;
      readonly status: TrackingStatus;
      readonly lastScan: TrackingScanEvent | null;
      readonly estimatedDeliveryAt: Date | null;
      readonly trackingUrl: string;
    }
  | {
      readonly kind: "no_provider";
      readonly carrier: string;
      readonly trackingNumber: string;
      readonly trackingUrl: string;
      readonly reason: "no_api_key" | "unsupported_carrier";
    };

export interface ProposedAction {
  readonly tool: string;
  readonly input: unknown;
  readonly reasoning: string;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
}
