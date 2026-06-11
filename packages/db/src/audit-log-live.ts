import { Effect, FiberRef, Layer } from "effect";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  AuditLogDbError,
  AuditLogService,
  redactDetails,
  type AuditActor,
  type AuditActorType,
  type AuditEntry,
  type AuditLogError,
  type ForCaseOptions,
  type RecordAuditEntryInput,
} from "@support-agent/services";
import {
  CaseId as makeCaseId,
  TenantId as makeTenantId,
  type CaseId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));
import { auditLog, type AuditLogRow } from "./schema.js";

const rowToEntry = (r: AuditLogRow): AuditEntry => ({
  id: r.id,
  tenantId: makeTenantId(r.tenantId),
  caseId: r.caseId ? makeCaseId(r.caseId) : null,
  actor: { type: r.actorType as AuditActorType, id: r.actorId },
  action: r.action,
  details: (r.details ?? {}) as Readonly<Record<string, unknown>>,
  occurredAt: r.occurredAt,
});

const wrap = <A>(
  operation: string,
  promise: Promise<A>,
): Effect.Effect<A, AuditLogDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new AuditLogDbError({ operation, cause }),
  });

export interface AuditLogLiveConfig {
  /**
   * When true, every `record` call has its `details` payload passed
   * through `redactDetails` before insert. Toggled at the bootstrap
   * via `AUDIT_LOG_REDACT_PII=1` env. Default `false` for full debug
   * fidelity in dev / test.
   */
  readonly redactPii: boolean;
}

/**
 * Parametric Live builder. Two pre-built variants are exported below:
 * `AuditLogServiceLive` (no redaction — backward compatible default)
 * and `AuditLogServiceLiveRedacted` (redaction on). Bootstrap picks
 * whichever the env var selects.
 */
export const AuditLogServiceLiveBuilder = (
  config: AuditLogLiveConfig,
): Layer.Layer<AuditLogService, never, DbClient> =>
  Layer.effect(
    AuditLogService,
    Effect.gen(function* () {
      const defaultDb = yield* DbClient;

      const record = (
        input: RecordAuditEntryInput,
      ): Effect.Effect<AuditEntry, AuditLogError> =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const details = config.redactPii
            ? redactDetails(input.details)
            : input.details;
          const inserted = yield* wrap(
            "record",
            db
              .insert(auditLog)
              .values({
                tenantId: input.tenantId,
                caseId: input.caseId ?? null,
                actorType: input.actor.type,
                actorId: input.actor.id,
                action: input.action,
                details,
              })
              .returning(),
          );
          const row = inserted[0];
          if (!row) {
            return yield* Effect.fail(
              new AuditLogDbError({
                operation: "record",
                cause: "insert returned no row",
              }),
            );
          }
          return rowToEntry(row);
        });

      const forCase = (
        caseId: CaseId,
        opts: ForCaseOptions = {},
      ): Effect.Effect<ReadonlyArray<AuditEntry>, AuditLogError> =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const limit = opts.limit ?? 100;
          // D9: enforce the tenant scope when given — a cross-tenant caseId
          // reads as an empty history.
          const whereClause = and(
            eq(auditLog.caseId, caseId),
            ...(opts.tenantId !== undefined
              ? [eq(auditLog.tenantId, opts.tenantId)]
              : []),
            ...(opts.afterId !== undefined
              ? [gt(auditLog.id, opts.afterId)]
              : []),
          );
          const rows = yield* wrap(
            "forCase",
            db
              .select()
              .from(auditLog)
              .where(whereClause)
              .orderBy(asc(auditLog.id))
              .limit(limit),
          );
          return rows.map(rowToEntry);
        });

      return AuditLogService.of({ record, forCase });
    }),
  );

/** Default Live impl — no redaction. */
export const AuditLogServiceLive = AuditLogServiceLiveBuilder({
  redactPii: false,
});

/** Redacted variant — applies `redactDetails` at insert time. */
export const AuditLogServiceLiveRedacted = AuditLogServiceLiveBuilder({
  redactPii: true,
});
