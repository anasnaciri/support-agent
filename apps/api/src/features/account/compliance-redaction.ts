import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  adminAuditLog,
  accountOpenrouterCredentials,
  DbClient,
  approvals,
  auditLog,
  tickets,
  connectorConnections,
  tenants,
} from "@support-agent/db";

// ============================================================
// Shopify-compliance redaction helpers
// ============================================================
//
// Two operations, both wrapped in a single SQL tx so an interrupted
// redaction leaves the DB in a consistent state — partial redaction
// would breach the same compliance contract the webhook is enforcing.
//
// Order matters because of FK constraints:
//   tenants ← connector_connections (ON DELETE CASCADE)
//   tenants ← tickets (NO CASCADE) ← state_transitions (CASCADE), approvals
//   audit_log has tenant_id but NO FK — we delete explicitly
//
// So for shop-wide redact: approvals → tickets → audit_log → (connector
// rows cascade when we drop the tenant). For per-customer redact we
// scope by ticket id since the customer matches at the ticket-context layer.

export interface RedactCustomerResult {
  readonly tenantId: string;
  readonly matchedTicketIds: ReadonlyArray<string>;
}

export interface RedactCustomerInput {
  readonly tenantId: string;
  readonly email: string | null;
  /** Shopify numeric id from the webhook payload, e.g. 191167. */
  readonly shopifyCustomerNumericId: number | null;
}

/**
 * Delete every ticket (and its transitions, approvals, audit rows) for a
 * given tenant that matches the customer identified in the redact
 * webhook. Match strategy: either `context.customerEmail` (stamped at
 * ticket-create time by the runtime) or `context.shopifyCustomerId`
 * (stamped when Shopify's searchByEmail succeeded). A ticket missing
 * both — e.g. created before the customer-ID slice landed — won't be
 * caught and would need a manual sweep; surface that via `matchedTicketIds`
 * so the caller can log it.
 */
export const redactCustomer = (
  input: RedactCustomerInput,
): Effect.Effect<RedactCustomerResult, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const email = input.email;
    const shopifyId = input.shopifyCustomerNumericId;
    if (!email && shopifyId === null) {
      return { tenantId: input.tenantId, matchedTicketIds: [] };
    }

    const matched = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          // Build the OR clause across the matching strategies.
          const conditions = [];
          if (email) {
            conditions.push(
              sql`${tickets.context}->>'customerEmail' = ${email}`,
            );
          }
          if (shopifyId !== null) {
            // Stored as Shopify GID string in our context, but the
            // webhook gives a numeric id. Try both the GID form and
            // the raw number-as-string.
            const gid = `gid://shopify/Customer/${shopifyId}`;
            conditions.push(
              sql`${tickets.context}->>'shopifyCustomerId' = ${gid}`,
            );
            conditions.push(
              sql`${tickets.context}->>'shopifyCustomerId' = ${String(shopifyId)}`,
            );
          }
          const matchClause = conditions.reduce<
            ReturnType<typeof or> | undefined
          >((acc, c) => (acc ? or(acc, c) : c), undefined);

          if (!matchClause) return [] as string[];

          const found = await tx
            .select({ id: tickets.id })
            .from(tickets)
            .where(and(eq(tickets.tenantId, input.tenantId), matchClause));
          const ids = found.map((r) => r.id);
          if (ids.length === 0) return ids;

          // Order: approvals (FK to tickets) → audit_log (no FK cascade) →
          // tickets (CASCADE drops state_transitions).
          await tx.delete(approvals).where(inArray(approvals.ticketId, ids));
          await tx.delete(auditLog).where(inArray(auditLog.ticketId, ids));
          await tx.delete(tickets).where(inArray(tickets.id, ids));
          return ids;
        }),
      catch: (cause) =>
        new Error(`redactCustomer failed: ${String(cause)}`),
    });

    return { tenantId: input.tenantId, matchedTicketIds: matched };
  });

// ============================================================
// Data-request acknowledgement
// ============================================================
//
// The `customers/data_request` webhook tells us a customer asked
// Shopify for their data; Shopify gives us 30 days to comply. We don't
// auto-fulfil — actually preparing the export is a manual op for now —
// but we persist a paper-trail row so ops has a queryable list of
// outstanding requests. Tenant id may be null when we receive a
// data_request for an unknown shop.

export interface RecordDataRequestInput {
  readonly tenantId: string;
  readonly shopDomain: string | null;
  readonly customerEmail: string | null;
  readonly shopifyCustomerNumericId: number | null;
  readonly dataRequestId: number | null;
  readonly ordersRequested: ReadonlyArray<number>;
}

export const recordDataRequest = (
  input: RecordDataRequestInput,
): Effect.Effect<void, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    yield* Effect.tryPromise({
      try: async () => {
        await db.insert(auditLog).values({
          tenantId: input.tenantId,
          ticketId: null,
          actorType: "system",
          actorId: "shopify-compliance",
          action: "compliance.data_request",
          details: {
            shopDomain: input.shopDomain,
            customer: {
              email: input.customerEmail,
              shopifyId: input.shopifyCustomerNumericId,
            },
            dataRequestId: input.dataRequestId,
            ordersRequested: input.ordersRequested,
            receivedAt: new Date().toISOString(),
            // Defensive: random id makes ops dedup easy if Shopify
            // double-delivers and we want to grep by it.
            traceId: randomUUID(),
          },
        });
      },
      catch: (cause) =>
        new Error(`recordDataRequest failed: ${String(cause)}`),
    });
  });

// ============================================================
// pg-boss payload redaction (audit D7)
// ============================================================
//
// `message.received` jobs carry full customer email bodies into
// `pgboss.job` (and, on older pg-boss versions, `pgboss.archive`) under
// `data->'event'->>'tenantId'` — see apps/worker's WorkflowJobData
// envelope `{ eventId, event, key, enqueuedAt }`. The tenant wipe must
// remove those rows too or the PII outlives the tenant. The predicate is
// deliberately the NESTED event tenantId: the `account.cleanup` job keeps
// its (encrypted) payload tenantId at TOP level and must SURVIVE the wipe
// — it is what finishes the deletion.

export interface QueueRedactionResult {
  readonly deletedJobRows: number;
  readonly deletedArchiveRows: number;
}

const SAFE_SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/** Postgres "relation/schema doesn't exist" — the dev ticket to tolerate. */
const isMissingRelation = (cause: unknown): boolean => {
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === "42P01" || code === "3F000") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/**
 * Delete every queue row whose event payload belongs to `tenantId` from
 * `<schema>.job` and `<schema>.archive`. Tolerant of the pgboss schema /
 * tables not existing (dev runs the api without the worker ever having
 * booted pg-boss); any other failure propagates so the caller retries.
 */
export const redactTenantQueueJobs = (
  tenantId: string,
  schema = "pgboss",
): Effect.Effect<QueueRedactionResult, Error, DbClient> =>
  Effect.gen(function* () {
    if (!SAFE_SCHEMA_NAME.test(schema)) {
      return yield* Effect.fail(
        new Error(`redactTenantQueueJobs: unsafe schema name ${JSON.stringify(schema)}`),
      );
    }
    const db = yield* DbClient;
    const deleteFrom = (table: "job" | "archive"): Effect.Effect<number, Error> =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db.execute(
            sql`DELETE FROM ${sql.raw(`"${schema}"."${table}"`)} WHERE data->'event'->>'tenantId' = ${tenantId} RETURNING 1`,
          );
          return Array.isArray(rows) ? rows.length : 0;
        },
        catch: (cause) =>
          new Error(`redactTenantQueueJobs(${table}) failed: ${String(cause)}`, {
            cause,
          }),
      }).pipe(
        Effect.catchAll((error) =>
          isMissingRelation(error.cause) ? Effect.succeed(0) : Effect.fail(error),
        ),
      );

    const deletedJobRows = yield* deleteFrom("job");
    const deletedArchiveRows = yield* deleteFrom("archive");
    return { deletedJobRows, deletedArchiveRows };
  });

export interface RedactShopResult {
  readonly tenantId: string;
  readonly deletedTickets: number;
  readonly deletedAuditRows: number;
  readonly deletedConnectorRows: number;
  /** `true` if the tenant row itself was deleted. */
  readonly tenantDeleted: boolean;
  /** pg-boss rows carrying the tenant's event payloads (audit D7). */
  readonly deletedQueueJobRows: number;
  readonly deletedQueueArchiveRows: number;
}

/**
 * A surviving platform-admin audit record to write IN THE SAME transaction as
 * the wipe (re-audit #2). Goes to `admin_audit_log`, which has no tenant FK so
 * it outlives the deleted tenant — the per-tenant `audit_log` is wiped here.
 */
export interface RedactShopAdminAudit {
  readonly action: string;
  /** Operator identity: "admin", "tenant_self", "shopify-compliance", … */
  readonly actor: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Wipe every row associated with a tenant. Used by the `shop/redact`
 * webhook 48h after a merchant uninstalls, AND by self-service / admin
 * account deletion (see `account-deletion.ts`) — both need the same
 * complete, atomic tenant wipe.
 *
 * We delete the tenant row last so the FK cascades fire cleanly on
 * `connector_connections` (defined ON DELETE CASCADE). Other tables
 * (tickets, approvals, audit_log) reference `tenant_id` without cascade,
 * so they go first.
 *
 * When `adminAudit` is provided, a surviving `admin_audit_log` row is written
 * in the SAME transaction as the wipe — so the privileged deletion is
 * recorded atomically and the record persists after the tenant is gone.
 */
export const redactShop = (
  tenantId: string,
  adminAudit?: RedactShopAdminAudit,
): Effect.Effect<RedactShopResult, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const wiped = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const [tenantBeforeDelete] = await tx
            .select({ organizationId: tenants.workosOrganizationId })
            .from(tenants)
            .where(eq(tenants.id, tenantId))
            .limit(1);
          const organizationId = tenantBeforeDelete?.organizationId ?? null;
          const orgWorkspaceCount = organizationId
            ? Number(
                (
                  await tx
                    .select({ count: sql<number>`count(*)::int` })
                    .from(tenants)
                    .where(eq(tenants.workosOrganizationId, organizationId))
                )[0]?.count ?? 0,
              )
            : 0;
          // 1. approvals (FK to tickets AND tenants; nuke by tenant)
          await tx.delete(approvals).where(eq(approvals.tenantId, tenantId));
          // 2. tickets (cascades to ticket_state_transitions)
          const deletedTickets = await tx
            .delete(tickets)
            .where(eq(tickets.tenantId, tenantId))
            .returning({ id: tickets.id });
          // 3. audit_log — no FK, delete by tenant_id
          const deletedAudit = await tx
            .delete(auditLog)
            .where(eq(auditLog.tenantId, tenantId))
            .returning({ id: auditLog.id });
          // 4. connector_connections cascades from the tenant drop,
          //    but explicit delete-first makes the count visible.
          const deletedConnectors = await tx
            .delete(connectorConnections)
            .where(eq(connectorConnections.tenantId, tenantId))
            .returning({ id: connectorConnections.id });
          // 5. The inherited account key belongs to the WorkOS org, not this
          // workspace. Remove it only when this is the org's final workspace.
          if (organizationId && orgWorkspaceCount <= 1) {
            await tx
              .delete(accountOpenrouterCredentials)
              .where(
                eq(accountOpenrouterCredentials.organizationId, organizationId),
              );
          }
          // 6. tenant row itself
          const deletedTenant = await tx
            .delete(tenants)
            .where(eq(tenants.id, tenantId))
            .returning({ id: tenants.id });
          // 7. surviving admin-audit record (re-audit #2) — last, so it
          //    captures the deleted counts and is NOT removed by step 3.
          if (adminAudit) {
            await tx.insert(adminAuditLog).values({
              action: adminAudit.action,
              targetTenantId: tenantId,
              actor: adminAudit.actor,
              details: {
                ...(adminAudit.details ?? {}),
                deletedTickets: deletedTickets.length,
                deletedAuditRows: deletedAudit.length,
                deletedConnectorRows: deletedConnectors.length,
                tenantDeleted: deletedTenant.length > 0,
                at: new Date().toISOString(),
                traceId: randomUUID(),
              },
            });
          }
          return {
            tenantId,
            deletedTickets: deletedTickets.length,
            deletedAuditRows: deletedAudit.length,
            deletedConnectorRows: deletedConnectors.length,
            tenantDeleted: deletedTenant.length > 0,
          };
        }),
      catch: (cause) => new Error(`redactShop failed: ${String(cause)}`),
    });
    // pg-boss payloads (audit D7) — AFTER the wipe tx commits: a failed wipe
    // must not have already destroyed the events of a still-live tenant. A
    // genuine failure here fails redactShop so the (idempotent) caller
    // retries the queue sweep; the row deletes above are already no-ops on
    // the retry.
    const queue = yield* redactTenantQueueJobs(tenantId);
    return {
      ...wiped,
      deletedQueueJobRows: queue.deletedJobRows,
      deletedQueueArchiveRows: queue.deletedArchiveRows,
    };
  });
