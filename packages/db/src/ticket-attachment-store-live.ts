import { Effect, FiberRef, Layer } from "effect";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  TicketAttachmentStore,
  TicketAttachmentStoreDbError,
  type RecordTicketAttachmentInput,
  type TicketAttachmentMessageBindingRecord,
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
import {
  ticketAttachmentMessages,
  ticketAttachments,
  type TicketAttachmentRow,
} from "./schema.js";

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
  messageId: null,
  usedAt: row.usedAt,
  createdAt: row.createdAt,
});

const toMessageBindingRecord = (row: {
  readonly id: string;
  readonly tenantId: string;
  readonly ticketId: string;
  readonly messageId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}): TicketAttachmentMessageBindingRecord => ({
  id: row.id,
  tenantId: makeTenantId(row.tenantId),
  ticketId: makeTicketId(row.ticketId),
  messageId: row.messageId,
  filename: row.filename,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
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
            })
            .returning(),
        );
        const record = toRecord(rows[0]!);
        if (input.messageId) {
          yield* wrap(
            "record.bindMessage",
            db
              .insert(ticketAttachmentMessages)
              .values({
                tenantId: input.tenantId,
                ticketId: input.ticketId,
                attachmentId: record.id,
                messageId: input.messageId,
              })
              .onConflictDoNothing(),
          );
          return { ...record, messageId: input.messageId };
        }
        return record;
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
              })),
            )
            // A redelivered `message.received` re-indexes the same blobs; the
            // first writer keeps the row (ticket_attachments_tenant_key_uniq).
            .onConflictDoNothing(),
        );
        const withMessage = inputs.filter((input) => input.messageId);
        if (withMessage.length === 0) return;
        const rows = yield* wrap(
          "recordInbound.lookupBindings",
          db
            .select({
              id: ticketAttachments.id,
              tenantId: ticketAttachments.tenantId,
              ticketId: ticketAttachments.ticketId,
              storageKey: ticketAttachments.storageKey,
            })
            .from(ticketAttachments)
            .where(
              inArray(
                ticketAttachments.storageKey,
                withMessage.map((input) => input.storageKey),
              ),
            ),
        );
        const byStorageKey = new Map(
          rows.map((row) => [`${row.tenantId}:${row.storageKey}`, row]),
        );
        const values = withMessage.flatMap((input) => {
          const row = byStorageKey.get(`${input.tenantId}:${input.storageKey}`);
          return row && input.messageId
            ? [
                {
                  tenantId: row.tenantId,
                  ticketId: row.ticketId,
                  attachmentId: row.id,
                  messageId: input.messageId,
                },
              ]
            : [];
        });
        if (values.length === 0) return;
        yield* wrap(
          "recordInbound.bindMessages",
          db
            .insert(ticketAttachmentMessages)
            .values(values)
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

    const listMessageBindingsForTicket = (
      tenantId: TenantId,
      ticketId: TicketId,
    ): Effect.Effect<
      ReadonlyArray<TicketAttachmentMessageBindingRecord>,
      TicketAttachmentStoreError
    > =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "listMessageBindingsForTicket",
          db
            .select({
              id: ticketAttachments.id,
              tenantId: ticketAttachments.tenantId,
              ticketId: ticketAttachments.ticketId,
              messageId: ticketAttachmentMessages.messageId,
              filename: ticketAttachments.filename,
              contentType: ticketAttachments.contentType,
              sizeBytes: ticketAttachments.sizeBytes,
            })
            .from(ticketAttachmentMessages)
            .innerJoin(
              ticketAttachments,
              and(
                eq(ticketAttachments.id, ticketAttachmentMessages.attachmentId),
                eq(ticketAttachments.tenantId, ticketAttachmentMessages.tenantId),
                eq(ticketAttachments.ticketId, ticketAttachmentMessages.ticketId),
              ),
            )
            .where(
              and(
                eq(ticketAttachmentMessages.tenantId, tenantId),
                eq(ticketAttachmentMessages.ticketId, ticketId),
              ),
            )
            .orderBy(
              ticketAttachmentMessages.createdAt,
              ticketAttachmentMessages.messageId,
            ),
        );
        return rows.map(toMessageBindingRecord);
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
            .insert(ticketAttachmentMessages)
            .values(
              ids.map((id) => ({
                tenantId,
                ticketId,
                attachmentId: id,
                messageId,
              })),
            )
            .onConflictDoNothing(),
        );
      });

    return TicketAttachmentStore.of({
      record,
      recordInbound,
      getByIds,
      listForTicket,
      listMessageBindingsForTicket,
      markUsed,
      bindToMessage,
    });
  }),
);
