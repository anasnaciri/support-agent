import { Context, Data, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import type {
  MessageAttachment,
  TicketId,
  TenantId,
} from "@support-agent/agent-core";

/**
 * Persistent index of attachment blobs bound to a ticket. The bytes live in
 * `BlobStorage`; a row here is the ONLY durable mapping from a ticket to a
 * storage key. Rows are referenced by opaque `id` everywhere outside the
 * trust boundary (dashboard clients, the supplier portal, LLM tool args) —
 * `getByIds` resolves ids strictly within one tenant + ticket, so a tampered
 * or hallucinated id can never reach another tenant's blob.
 */

export type TicketAttachmentSource = "inbound" | "supplier" | "merchant";

export interface RecordTicketAttachmentInput {
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  readonly source: TicketAttachmentSource;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
  /**
   * Who uploaded it — WorkOS user id for merchants, portal user id for
   * suppliers, null for connector-ingested customer attachments.
   */
  readonly uploadedBy?: string | null;
  /**
   * The supplier escalation this file was uploaded against — supplier uploads
   * only. Scopes the update's id validation to one escalation and drives the
   * portal's "files you sent" view.
   */
  readonly escalationId?: string | null;
}

export interface TicketAttachmentRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  readonly source: TicketAttachmentSource;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
  readonly uploadedBy: string | null;
  readonly escalationId: string | null;
  readonly createdAt: Date;
}

/** Project a stored row to the wire/send shape carried on a ConversationReply. */
export const toMessageAttachment = (
  record: TicketAttachmentRecord,
): MessageAttachment => ({
  filename: record.filename,
  contentType: record.contentType,
  storageKey: record.storageKey,
  sizeBytes: record.sizeBytes,
});

export class TicketAttachmentStoreDbError extends Data.TaggedError(
  "TicketAttachmentStoreDbError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type TicketAttachmentStoreError = TicketAttachmentStoreDbError;

export class TicketAttachmentStore extends Context.Tag("TicketAttachmentStore")<
  TicketAttachmentStore,
  {
    readonly record: (
      input: RecordTicketAttachmentInput,
    ) => Effect.Effect<TicketAttachmentRecord, TicketAttachmentStoreError>;
    /**
     * Resolve attachment ids within one tenant + ticket. Ids that don't
     * exist or belong to another tenant/ticket are silently absent from the
     * result — callers compare lengths when a miss must be an error.
     * Returns rows in the order the ids were given.
     */
    readonly getByIds: (
      tenantId: TenantId,
      ticketId: TicketId,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyArray<TicketAttachmentRecord>,
      TicketAttachmentStoreError
    >;
    readonly listForTicket: (
      tenantId: TenantId,
      ticketId: TicketId,
    ) => Effect.Effect<
      ReadonlyArray<TicketAttachmentRecord>,
      TicketAttachmentStoreError
    >;
  }
>() {}

/** In-memory store for unit tests; mirrors Live's id-scoping semantics. */
export const TicketAttachmentStoreTest = (
  seed: ReadonlyArray<TicketAttachmentRecord> = [],
) =>
  Layer.effect(
    TicketAttachmentStore,
    Effect.sync(() => {
      const rows: TicketAttachmentRecord[] = [...seed];
      const scoped = (tenantId: TenantId, ticketId: TicketId) =>
        rows.filter(
          (r) => r.tenantId === tenantId && r.ticketId === ticketId,
        );
      return TicketAttachmentStore.of({
        record: (input) =>
          Effect.sync(() => {
            const row: TicketAttachmentRecord = {
              id: randomUUID(),
              tenantId: input.tenantId,
              ticketId: input.ticketId,
              source: input.source,
              filename: input.filename,
              contentType: input.contentType,
              sizeBytes: input.sizeBytes,
              storageKey: input.storageKey,
              uploadedBy: input.uploadedBy ?? null,
              escalationId: input.escalationId ?? null,
              createdAt: new Date(),
            };
            rows.push(row);
            return row;
          }),
        getByIds: (tenantId, ticketId, ids) =>
          Effect.sync(() => {
            const inScope = scoped(tenantId, ticketId);
            return ids.flatMap((id) => {
              const hit = inScope.find((r) => r.id === id);
              return hit ? [hit] : [];
            });
          }),
        listForTicket: (tenantId, ticketId) =>
          Effect.sync(() => scoped(tenantId, ticketId)),
      });
    }),
  );
