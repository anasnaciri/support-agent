import { Context, Effect, Layer } from "effect";
import {
  type ConnectorStoreDbError,
  type TenantId,
} from "@support-agent/agent-core";

// ============================================================
// Types
// ============================================================

export type KnowledgeSourceType = "text" | "url";

/**
 * One tenant knowledge document. `content` is the readable text the agents see
 * — either pasted verbatim (`text`) or extracted from a fetched page (`url`).
 * For a `url` doc, `sourceUrl` is the page, `fetchedAt` stamps the last
 * snapshot, and `contentHash` lets a re-sync no-op when the page is unchanged.
 */
export interface KnowledgeDocument {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly sourceType: KnowledgeSourceType;
  readonly sourceUrl: string | null;
  readonly contentHash: string | null;
  readonly fetchedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** List-view projection — everything except the (potentially large) `content`. */
export interface KnowledgeDocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly sourceType: KnowledgeSourceType;
  readonly sourceUrl: string | null;
  readonly fetchedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Fields supplied when creating a doc — the api computes hash/fetchedAt first. */
export interface KnowledgeCreateInput {
  readonly title: string;
  readonly content: string;
  readonly sourceType: KnowledgeSourceType;
  readonly sourceUrl: string | null;
  readonly contentHash: string | null;
  readonly fetchedAt: Date | null;
}

/** Patch for an update — only the provided fields change. */
export interface KnowledgeUpdateInput {
  readonly title?: string;
  readonly content?: string;
  readonly contentHash?: string | null;
  readonly fetchedAt?: Date | null;
}

const toSummary = (d: KnowledgeDocument): KnowledgeDocumentSummary => ({
  id: d.id,
  title: d.title,
  sourceType: d.sourceType,
  sourceUrl: d.sourceUrl,
  fetchedAt: d.fetchedAt,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

// ============================================================
// Tag
// ============================================================

/**
 * Tenant-wide knowledge base. `listTitles` runs once per runtime tick (to seed
 * the system-prompt header), `listFull` backs the `knowledge.search` tool, and
 * the rest serve the dashboard CRUD. Every method is tenant-scoped; reads/writes
 * for another tenant's id resolve to null / false (→ 404 at the api).
 */
export class KnowledgeBaseService extends Context.Tag("KnowledgeBaseService")<
  KnowledgeBaseService,
  {
    /** Titles only — cheapest read, used to seed the agent prompt header. */
    readonly listTitles: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<string>, ConnectorStoreDbError>;

    /** Summaries (no content) for the dashboard list. */
    readonly list: (
      tenantId: TenantId,
    ) => Effect.Effect<
      ReadonlyArray<KnowledgeDocumentSummary>,
      ConnectorStoreDbError
    >;

    /** Full documents — the `knowledge.search` tool ranks over these. */
    readonly listFull: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<KnowledgeDocument>, ConnectorStoreDbError>;

    /** One full document, or null when absent / owned by another tenant. */
    readonly get: (
      tenantId: TenantId,
      id: string,
    ) => Effect.Effect<KnowledgeDocument | null, ConnectorStoreDbError>;

    /** Document count — used to enforce the per-tenant cap on create. */
    readonly count: (
      tenantId: TenantId,
    ) => Effect.Effect<number, ConnectorStoreDbError>;

    readonly create: (
      tenantId: TenantId,
      input: KnowledgeCreateInput,
    ) => Effect.Effect<KnowledgeDocument, ConnectorStoreDbError>;

    /** Update; returns null when the id is absent / owned by another tenant. */
    readonly update: (
      tenantId: TenantId,
      id: string,
      patch: KnowledgeUpdateInput,
    ) => Effect.Effect<KnowledgeDocument | null, ConnectorStoreDbError>;

    /** Delete; returns false when the id is absent / owned by another tenant. */
    readonly remove: (
      tenantId: TenantId,
      id: string,
    ) => Effect.Effect<boolean, ConnectorStoreDbError>;
  }
>() {}

// ============================================================
// Test Layer — in-memory, mutable
// ============================================================

export const KnowledgeBaseServiceTest = (
  seed: ReadonlyArray<{
    readonly tenantId: TenantId;
    readonly id?: string;
    readonly title: string;
    readonly content: string;
    readonly sourceType: KnowledgeSourceType;
    readonly sourceUrl?: string | null;
    readonly contentHash?: string | null;
    readonly fetchedAt?: Date | null;
    readonly createdAt?: Date;
    readonly updatedAt?: Date;
  }> = [],
) =>
  Layer.sync(KnowledgeBaseService, () => {
    let counter = 0;
    const store = new Map<
      string,
      { tenantId: TenantId; doc: KnowledgeDocument }
    >();

    for (const row of seed) {
      const id = row.id ?? `kb-seed-${++counter}`;
      const now = row.createdAt ?? new Date();
      store.set(id, {
        tenantId: row.tenantId,
        doc: {
          id,
          title: row.title,
          content: row.content,
          sourceType: row.sourceType,
          sourceUrl: row.sourceUrl ?? null,
          contentHash: row.contentHash ?? null,
          fetchedAt: row.fetchedAt ?? null,
          createdAt: now,
          updatedAt: row.updatedAt ?? now,
        },
      });
    }

    // Insertion-ordered (createdAt asc) — matches the Live `orderBy(createdAt)`.
    const forTenant = (tenantId: TenantId): KnowledgeDocument[] =>
      [...store.values()]
        .filter((e) => e.tenantId === tenantId)
        .map((e) => e.doc)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const owned = (tenantId: TenantId, id: string): KnowledgeDocument | null => {
      const e = store.get(id);
      return e && e.tenantId === tenantId ? e.doc : null;
    };

    return KnowledgeBaseService.of({
      listTitles: (tenantId) =>
        Effect.sync(() => forTenant(tenantId).map((d) => d.title)),

      list: (tenantId) =>
        Effect.sync(() => forTenant(tenantId).map(toSummary)),

      listFull: (tenantId) => Effect.sync(() => forTenant(tenantId)),

      get: (tenantId, id) => Effect.sync(() => owned(tenantId, id)),

      count: (tenantId) => Effect.sync(() => forTenant(tenantId).length),

      create: (tenantId, input) =>
        Effect.sync(() => {
          const id = `kb-${++counter}`;
          const now = new Date();
          const doc: KnowledgeDocument = {
            id,
            title: input.title,
            content: input.content,
            sourceType: input.sourceType,
            sourceUrl: input.sourceUrl,
            contentHash: input.contentHash,
            fetchedAt: input.fetchedAt,
            createdAt: now,
            updatedAt: now,
          };
          store.set(id, { tenantId, doc });
          return doc;
        }),

      update: (tenantId, id, patch) =>
        Effect.sync(() => {
          const prev = owned(tenantId, id);
          if (!prev) return null;
          const doc: KnowledgeDocument = {
            ...prev,
            title: patch.title ?? prev.title,
            content: patch.content ?? prev.content,
            contentHash:
              patch.contentHash !== undefined
                ? patch.contentHash
                : prev.contentHash,
            fetchedAt:
              patch.fetchedAt !== undefined ? patch.fetchedAt : prev.fetchedAt,
            updatedAt: new Date(),
          };
          store.set(id, { tenantId, doc });
          return doc;
        }),

      remove: (tenantId, id) =>
        Effect.sync(() => {
          if (!owned(tenantId, id)) return false;
          store.delete(id);
          return true;
        }),
    });
  });
