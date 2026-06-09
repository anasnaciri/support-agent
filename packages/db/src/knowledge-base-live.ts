import { Effect, FiberRef, Layer } from "effect";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  KnowledgeBaseService,
  type KnowledgeDocument,
  type KnowledgeDocumentSummary,
  type KnowledgeSourceType,
} from "@support-agent/services";
import {
  ConnectorStoreDbError,
  type TenantId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import {
  tenantKnowledgeDocuments,
  type TenantKnowledgeDocumentInsert,
  type TenantKnowledgeDocumentRow,
} from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const wrap = <A>(
  promise: Promise<A>,
): Effect.Effect<A, ConnectorStoreDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new ConnectorStoreDbError({ cause }),
  });

const rowToDoc = (r: TenantKnowledgeDocumentRow): KnowledgeDocument => ({
  id: r.id,
  title: r.title,
  content: r.content,
  sourceType: r.sourceType as KnowledgeSourceType,
  sourceUrl: r.sourceUrl,
  contentHash: r.contentHash,
  fetchedAt: r.fetchedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export const KnowledgeBaseServiceLive = Layer.effect(
  KnowledgeBaseService,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    return KnowledgeBaseService.of({
      listTitles: (tenantId: TenantId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select({ title: tenantKnowledgeDocuments.title })
              .from(tenantKnowledgeDocuments)
              .where(eq(tenantKnowledgeDocuments.tenantId, tenantId))
              .orderBy(asc(tenantKnowledgeDocuments.createdAt)),
          );
          return rows.map((r) => r.title);
        }),

      // Summary list omits `content` so the dashboard list never pulls
      // potentially-large bodies.
      list: (tenantId: TenantId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select({
                id: tenantKnowledgeDocuments.id,
                title: tenantKnowledgeDocuments.title,
                sourceType: tenantKnowledgeDocuments.sourceType,
                sourceUrl: tenantKnowledgeDocuments.sourceUrl,
                fetchedAt: tenantKnowledgeDocuments.fetchedAt,
                createdAt: tenantKnowledgeDocuments.createdAt,
                updatedAt: tenantKnowledgeDocuments.updatedAt,
              })
              .from(tenantKnowledgeDocuments)
              .where(eq(tenantKnowledgeDocuments.tenantId, tenantId))
              .orderBy(asc(tenantKnowledgeDocuments.createdAt)),
          );
          return rows.map(
            (r): KnowledgeDocumentSummary => ({
              id: r.id,
              title: r.title,
              sourceType: r.sourceType as KnowledgeSourceType,
              sourceUrl: r.sourceUrl,
              fetchedAt: r.fetchedAt,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
            }),
          );
        }),

      listFull: (tenantId: TenantId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select()
              .from(tenantKnowledgeDocuments)
              .where(eq(tenantKnowledgeDocuments.tenantId, tenantId))
              .orderBy(asc(tenantKnowledgeDocuments.createdAt)),
          );
          return rows.map(rowToDoc);
        }),

      get: (tenantId: TenantId, id: string) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select()
              .from(tenantKnowledgeDocuments)
              .where(
                and(
                  eq(tenantKnowledgeDocuments.id, id),
                  eq(tenantKnowledgeDocuments.tenantId, tenantId),
                ),
              )
              .limit(1),
          );
          return rows[0] ? rowToDoc(rows[0]) : null;
        }),

      count: (tenantId: TenantId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select({ n: sql<number>`count(*)::int` })
              .from(tenantKnowledgeDocuments)
              .where(eq(tenantKnowledgeDocuments.tenantId, tenantId)),
          );
          return rows[0]?.n ?? 0;
        }),

      create: (tenantId: TenantId, input) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .insert(tenantKnowledgeDocuments)
              .values({
                tenantId,
                title: input.title,
                content: input.content,
                sourceType: input.sourceType,
                sourceUrl: input.sourceUrl,
                contentHash: input.contentHash,
                fetchedAt: input.fetchedAt,
              })
              .returning(),
          );
          return rowToDoc(rows[0]!);
        }),

      update: (tenantId: TenantId, id: string, patch) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const set: Partial<TenantKnowledgeDocumentInsert> = {
            updatedAt: new Date(),
          };
          if (patch.title !== undefined) set.title = patch.title;
          if (patch.content !== undefined) set.content = patch.content;
          if (patch.contentHash !== undefined) set.contentHash = patch.contentHash;
          if (patch.fetchedAt !== undefined) set.fetchedAt = patch.fetchedAt;
          const rows = yield* wrap(
            db
              .update(tenantKnowledgeDocuments)
              .set(set)
              .where(
                and(
                  eq(tenantKnowledgeDocuments.id, id),
                  eq(tenantKnowledgeDocuments.tenantId, tenantId),
                ),
              )
              .returning(),
          );
          return rows[0] ? rowToDoc(rows[0]) : null;
        }),

      remove: (tenantId: TenantId, id: string) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .delete(tenantKnowledgeDocuments)
              .where(
                and(
                  eq(tenantKnowledgeDocuments.id, id),
                  eq(tenantKnowledgeDocuments.tenantId, tenantId),
                ),
              )
              .returning({ id: tenantKnowledgeDocuments.id }),
          );
          return rows.length > 0;
        }),
    });
  }),
);
