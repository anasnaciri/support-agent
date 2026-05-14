import { Context, Data, Effect, Layer } from "effect";
import type { CaseId, TenantId } from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

export class AuditLogDbError extends Data.TaggedError("AuditLogDbError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type AuditLogError = AuditLogDbError;

// ============================================================
// Types
// ============================================================

export type AuditActorType = "agent" | "user" | "system" | "customer";

export interface AuditActor {
  readonly type: AuditActorType;
  readonly id: string | null;
}

export interface AuditEntry {
  readonly id: bigint;
  readonly tenantId: TenantId;
  readonly caseId: CaseId | null;
  readonly actor: AuditActor;
  readonly action: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export interface RecordAuditEntryInput {
  readonly tenantId: TenantId;
  readonly caseId?: CaseId | null;
  readonly actor: AuditActor;
  readonly action: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ForCaseOptions {
  readonly limit?: number;
  readonly afterId?: bigint;
}

// ============================================================
// Tag
// ============================================================

export class AuditLogService extends Context.Tag("AuditLogService")<
  AuditLogService,
  {
    readonly record: (
      entry: RecordAuditEntryInput,
    ) => Effect.Effect<AuditEntry, AuditLogError>;

    readonly forCase: (
      caseId: CaseId,
      opts?: ForCaseOptions,
    ) => Effect.Effect<ReadonlyArray<AuditEntry>, AuditLogError>;
  }
>() {}

// ============================================================
// Test layer — in-memory
// ============================================================

export const AuditLogServiceTest = Layer.effect(
  AuditLogService,
  Effect.sync(() => {
    let nextId = 1n;
    const entries: AuditEntry[] = [];

    return AuditLogService.of({
      record: (input) =>
        Effect.sync(() => {
          const entry: AuditEntry = {
            id: nextId++,
            tenantId: input.tenantId,
            caseId: input.caseId ?? null,
            actor: input.actor,
            action: input.action,
            details: input.details,
            occurredAt: new Date(),
          };
          entries.push(entry);
          return entry;
        }),

      forCase: (caseId, opts = {}) =>
        Effect.sync(() => {
          const limit = opts.limit ?? 100;
          let filtered = entries.filter((e) => e.caseId === caseId);
          if (opts.afterId !== undefined) {
            const after = opts.afterId;
            filtered = filtered.filter((e) => e.id > after);
          }
          return filtered.slice(0, limit);
        }),
    });
  }),
);
