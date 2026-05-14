import { Effect, Layer } from "effect";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  AuditLogDbError,
  AuditLogService,
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
import { DbClient } from "./db-client.js";
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

export const AuditLogServiceLive = Layer.effect(
  AuditLogService,
  Effect.gen(function* () {
    const db = yield* DbClient;

    const record = (
      input: RecordAuditEntryInput,
    ): Effect.Effect<AuditEntry, AuditLogError> =>
      Effect.gen(function* () {
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
              details: input.details,
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
        const limit = opts.limit ?? 100;
        const whereClause =
          opts.afterId !== undefined
            ? and(eq(auditLog.caseId, caseId), gt(auditLog.id, opts.afterId))
            : eq(auditLog.caseId, caseId);
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
