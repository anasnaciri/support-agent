import { Context, Data, Effect, Layer } from "effect";
import type { TicketId, TenantId } from "@support-agent/agent-core";

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
  readonly ticketId: TicketId | null;
  readonly actor: AuditActor;
  readonly action: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export interface RecordAuditEntryInput {
  readonly tenantId: TenantId;
  readonly ticketId?: TicketId | null;
  readonly actor: AuditActor;
  readonly action: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ForTicketOptions {
  readonly limit?: number;
  readonly afterId?: bigint;
  /**
   * Defense-in-depth tenant scope (audit D9): when present, only entries
   * belonging to the tenant are returned — a cross-tenant ticketId reads as
   * an empty history.
   */
  readonly tenantId?: TenantId;
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

    readonly forTicket: (
      ticketId: TicketId,
      opts?: ForTicketOptions,
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
            ticketId: input.ticketId ?? null,
            actor: input.actor,
            action: input.action,
            details: input.details,
            occurredAt: new Date(),
          };
          entries.push(entry);
          return entry;
        }),

      forTicket: (ticketId, opts = {}) =>
        Effect.sync(() => {
          const limit = opts.limit ?? 100;
          let filtered = entries.filter((e) => e.ticketId === ticketId);
          if (opts.tenantId !== undefined) {
            const tenantId = opts.tenantId;
            filtered = filtered.filter((e) => e.tenantId === tenantId);
          }
          if (opts.afterId !== undefined) {
            const after = opts.afterId;
            filtered = filtered.filter((e) => e.id > after);
          }
          return filtered.slice(0, limit);
        }),
    });
  }),
);
