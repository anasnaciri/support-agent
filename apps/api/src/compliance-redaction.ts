import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  DbClient,
  approvals,
  auditLog,
  cases,
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
//   tenants ← cases (NO CASCADE) ← state_transitions (CASCADE), approvals
//   audit_log has tenant_id but NO FK — we delete explicitly
//
// So for shop-wide redact: approvals → cases → audit_log → (connector
// rows cascade when we drop the tenant). For per-customer redact we
// scope by case id since the customer matches at the case-context layer.

export interface RedactCustomerResult {
  readonly tenantId: string;
  readonly matchedCaseIds: ReadonlyArray<string>;
}

export interface RedactCustomerInput {
  readonly tenantId: string;
  readonly email: string | null;
  /** Shopify numeric id from the webhook payload, e.g. 191167. */
  readonly shopifyCustomerNumericId: number | null;
}

/**
 * Delete every case (and its transitions, approvals, audit rows) for a
 * given tenant that matches the customer identified in the redact
 * webhook. Match strategy: either `context.customerEmail` (stamped at
 * case-create time by the runtime) or `context.shopifyCustomerId`
 * (stamped when Shopify's searchByEmail succeeded). A case missing
 * both — e.g. created before the customer-ID slice landed — won't be
 * caught and would need a manual sweep; surface that via `matchedCaseIds`
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
      return { tenantId: input.tenantId, matchedCaseIds: [] };
    }

    const matched = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          // Build the OR clause across the matching strategies.
          const conditions = [];
          if (email) {
            conditions.push(
              sql`${cases.context}->>'customerEmail' = ${email}`,
            );
          }
          if (shopifyId !== null) {
            // Stored as Shopify GID string in our context, but the
            // webhook gives a numeric id. Try both the GID form and
            // the raw number-as-string.
            const gid = `gid://shopify/Customer/${shopifyId}`;
            conditions.push(
              sql`${cases.context}->>'shopifyCustomerId' = ${gid}`,
            );
            conditions.push(
              sql`${cases.context}->>'shopifyCustomerId' = ${String(shopifyId)}`,
            );
          }
          const matchClause = conditions.reduce<
            ReturnType<typeof or> | undefined
          >((acc, c) => (acc ? or(acc, c) : c), undefined);

          if (!matchClause) return [] as string[];

          const found = await tx
            .select({ id: cases.id })
            .from(cases)
            .where(and(eq(cases.tenantId, input.tenantId), matchClause));
          const ids = found.map((r) => r.id);
          if (ids.length === 0) return ids;

          // Order: approvals (FK to cases) → audit_log (no FK cascade) →
          // cases (CASCADE drops state_transitions).
          await tx.delete(approvals).where(inArray(approvals.caseId, ids));
          await tx.delete(auditLog).where(inArray(auditLog.caseId, ids));
          await tx.delete(cases).where(inArray(cases.id, ids));
          return ids;
        }),
      catch: (cause) =>
        new Error(`redactCustomer failed: ${String(cause)}`),
    });

    return { tenantId: input.tenantId, matchedCaseIds: matched };
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
          caseId: null,
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

export interface RedactShopResult {
  readonly tenantId: string;
  readonly deletedCases: number;
  readonly deletedAuditRows: number;
  readonly deletedConnectorRows: number;
  /** `true` if the tenant row itself was deleted. */
  readonly tenantDeleted: boolean;
}

/**
 * Wipe every row associated with a tenant. Used by the `shop/redact`
 * webhook 48h after a merchant uninstalls.
 *
 * We delete the tenant row last so the FK cascades fire cleanly on
 * `connector_connections` (defined ON DELETE CASCADE). Other tables
 * (cases, approvals, audit_log) reference `tenant_id` without cascade,
 * so they go first.
 */
export const redactShop = (
  tenantId: string,
): Effect.Effect<RedactShopResult, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    return yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          // 1. approvals (FK to cases AND tenants; nuke by tenant)
          await tx.delete(approvals).where(eq(approvals.tenantId, tenantId));
          // 2. cases (cascades to case_state_transitions)
          const deletedCases = await tx
            .delete(cases)
            .where(eq(cases.tenantId, tenantId))
            .returning({ id: cases.id });
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
          // 5. tenant row itself
          const deletedTenant = await tx
            .delete(tenants)
            .where(eq(tenants.id, tenantId))
            .returning({ id: tenants.id });
          return {
            tenantId,
            deletedCases: deletedCases.length,
            deletedAuditRows: deletedAudit.length,
            deletedConnectorRows: deletedConnectors.length,
            tenantDeleted: deletedTenant.length > 0,
          };
        }),
      catch: (cause) => new Error(`redactShop failed: ${String(cause)}`),
    });
  });
