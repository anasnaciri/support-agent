import { Effect, FiberRef, Layer } from "effect";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  TicketAttachmentStore,
  TicketAttachmentStoreDbError,
  type RecordTicketAttachmentInput,
  type TicketAttachmentRecord,
  type TicketAttachmentSource,
  type TicketAttachmentStoreError,
} from "@support-agent/services";
import {
  TicketId as makeTicketId,
  TenantId as makeTenantId,
  type TicketId,
  type TenantId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import { ticketAttachments, type TicketAttachmentRow } from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const wrap = <A>(
  operation: string,
  promise: Promise<A>,
): Effect.Effect<A, TicketAttachmentStoreDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new TicketAttachmentStoreDbError({ operation, cause }),
  });

const toRecord = (row: TicketAttachmentRow): TicketAttachmentRecord => ({
  id: row.id,
  tenantId: makeTenantId(row.tenantId),
  ticketId: makeTicketId(row.ticketId),
  source: row.source as TicketAttachmentSource,
  filename: row.filename,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  storageKey: row.storageKey,
  uploadedBy: row.uploadedBy,
  escalationId: row.escalationId,
  messageId: row.messageId,
  usedAt: row.usedAt,
  createdAt: row.createdAt,
});

export const TicketAttachmentStoreLive = Layer.effect(
  TicketAttachmentStore,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    const record = (
      input: RecordTicketAttachmentInput,
    ): Effect.Effect<TicketAttachmentRecord, TicketAttachmentStoreError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "record",
          db
            .insert(ticketAttachments)
            .values({
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
              messageId: input.messageId ?? null,
            })
            .returning(),
        );
        return toRecord(rows[0]!);
      });

    const recordInbound = (
      inputs: ReadonlyArray<RecordTicketAttachmentInput>,
    ): Effect.Effect<void, TicketAttachmentStoreError> =>
      Effect.gen(function* () {
        if (inputs.length === 0) return;
        const db = yield* useDb(defaultDb);
        yield* wrap(
          "recordInbound",
          db
            .insert(ticketAttachments)
            .values(
              inputs.map((input) => ({
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
                messageId: input.messageId ?? null,
              })),
            )
            // A redelivered `message.received` re-indexes the same blobs; the
            // first writer keeps the row (ticket_attachments_tenant_key_uniq).
            .onConflictDoNothing(),
        );
      });

    const getByIds = (
      tenantId: TenantId,
      ticketId: TicketId,
      ids: ReadonlyArray<string>,
    ): Effect.Effect<
      ReadonlyArray<TicketAttachmentRecord>,
      TicketAttachmentStoreError
    > =>
      Effect.gen(function* () {
        if (ids.length === 0) return [];
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "getByIds",
          db
            .select()
            .from(ticketAttachments)
            .where(
              and(
                eq(ticketAttachments.tenantId, tenantId),
                eq(ticketAttachments.ticketId, ticketId),
                inArray(ticketAttachments.id, [...ids]),
              ),
            ),
        );
        // Preserve the caller's id order (SQL IN gives no ordering).
        const byId = new Map(rows.map((r) => [r.id, toRecord(r)]));
        return ids.flatMap((id) => {
          const hit = byId.get(id);
          return hit ? [hit] : [];
        });
      });

    const listForTicket = (
      tenantId: TenantId,
      ticketId: TicketId,
    ): Effect.Effect<
      ReadonlyArray<TicketAttachmentRecord>,
      TicketAttachmentStoreError
    > =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "listForTicket",
          db
            .select()
            .from(ticketAttachments)
            .where(
              and(
                eq(ticketAttachments.tenantId, tenantId),
                eq(ticketAttachments.ticketId, ticketId),
              ),
            )
            .orderBy(ticketAttachments.createdAt),
        );
        return rows.map(toRecord);
      });

    const markUsed = (
      tenantId: TenantId,
      ticketId: TicketId,
      ids: ReadonlyArray<string>,
    ): Effect.Effect<void, TicketAttachmentStoreError> =>
      Effect.gen(function* () {
        if (ids.length === 0) return;
        const db = yield* useDb(defaultDb);
        yield* wrap(
          "markUsed",
          db
            .update(ticketAttachments)
            .set({ usedAt: new Date() })
            .where(
              and(
                eq(ticketAttachments.tenantId, tenantId),
                eq(ticketAttachments.ticketId, ticketId),
                inArray(ticketAttachments.id, [...ids]),
                // Keep the FIRST use: re-sends and retries must not push the
                // timestamp forward (and the sweep only cares about NULL).
                isNull(ticketAttachments.usedAt),
              ),
            ),
        );
      });

    const bindToMessage = (
      tenantId: TenantId,
      ticketId: TicketId,
      ids: ReadonlyArray<string>,
      messageId: string,
    ): Effect.Effect<void, TicketAttachmentStoreError> =>
      Effect.gen(function* () {
        if (ids.length === 0 || messageId.length === 0) return;
        const db = yield* useDb(defaultDb);
        yield* wrap(
          "bindToMessage",
          db
            .update(ticketAttachments)
            .set({ messageId })
            .where(
              and(
                eq(ticketAttachments.tenantId, tenantId),
                eq(ticketAttachments.ticketId, ticketId),
                inArray(ticketAttachments.id, [...ids]),
                // First binding wins — an inbound file keeps the message it
                // arrived on even when a reply forwards it back out.
                isNull(ticketAttachments.messageId),
              ),
            ),
        );
      });

    return TicketAttachmentStore.of({
      record,
      recordInbound,
      getByIds,
      listForTicket,
      markUsed,
      bindToMessage,
    });
  }),
);
