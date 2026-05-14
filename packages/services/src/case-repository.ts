import { Context, Data, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import {
  type AgentId,
  type Case,
  type CaseChannel,
  type CaseContext,
  type CaseId,
  type CasePriority,
  type CaseStatus,
  type CustomerId,
  type OrderId,
  type TenantId,
  type ThreadId,
  CaseId as makeCaseId,
} from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

export class CaseNotFound extends Data.TaggedError("CaseNotFound")<{
  readonly caseId: CaseId;
}> {}

export class CaseStateConflict extends Data.TaggedError("CaseStateConflict")<{
  readonly caseId: CaseId;
  readonly expected: CaseStatus;
  readonly actual: CaseStatus;
}> {}

export class CaseRepositoryDbError extends Data.TaggedError(
  "CaseRepositoryDbError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type CaseRepositoryError =
  | CaseNotFound
  | CaseStateConflict
  | CaseRepositoryDbError;

// ============================================================
// Inputs
// ============================================================

export interface CreateCaseInput {
  readonly tenantId: TenantId;
  readonly channel: CaseChannel;
  readonly currentAgentId: AgentId;
  readonly customerId?: CustomerId | null;
  readonly orderId?: OrderId | null;
  readonly threadId?: ThreadId | null;
  readonly category?: string | null;
  readonly priority?: CasePriority;
  readonly status?: CaseStatus;
  readonly subject?: string | null;
  readonly summary?: string | null;
  readonly context?: CaseContext;
}

/**
 * Fields callers may patch via `update`. `status` is intentionally excluded —
 * status changes MUST flow through `transitionStatus` so the
 * `case_state_transitions` row is written atomically (master-plan §10).
 */
export type UpdatableCaseFields = Partial<
  Pick<
    Case,
    | "customerId"
    | "orderId"
    | "threadId"
    | "category"
    | "currentAgentId"
    | "priority"
    | "subject"
    | "summary"
    | "context"
  >
>;

export interface TransitionStatusOptions {
  readonly expectedFromStatus?: CaseStatus;
  readonly eventId?: string;
  readonly reason?: string;
}

// ============================================================
// Tag
// ============================================================

export class CaseRepository extends Context.Tag("CaseRepository")<
  CaseRepository,
  {
    readonly create: (
      input: CreateCaseInput,
    ) => Effect.Effect<Case, CaseRepositoryError>;

    readonly getById: (
      id: CaseId,
    ) => Effect.Effect<Case, CaseRepositoryError>;

    readonly findByThreadId: (
      tenantId: TenantId,
      threadId: ThreadId,
    ) => Effect.Effect<Case | null, CaseRepositoryError>;

    readonly update: (
      id: CaseId,
      patch: UpdatableCaseFields,
    ) => Effect.Effect<Case, CaseRepositoryError>;

    readonly transitionStatus: (
      id: CaseId,
      toStatus: CaseStatus,
      opts?: TransitionStatusOptions,
    ) => Effect.Effect<Case, CaseRepositoryError>;
  }
>() {}

// ============================================================
// Test layer — in-memory
// ============================================================

const buildCase = (input: CreateCaseInput, now: Date): Case => ({
  id: makeCaseId(randomUUID()),
  tenantId: input.tenantId,
  customerId: input.customerId ?? null,
  orderId: input.orderId ?? null,
  channel: input.channel,
  threadId: input.threadId ?? null,
  category: input.category ?? null,
  status: input.status ?? "new",
  currentAgentId: input.currentAgentId,
  priority: input.priority ?? "normal",
  summary: input.summary ?? null,
  subject: input.subject ?? null,
  context: input.context ?? {},
  createdAt: now,
  updatedAt: now,
  resolvedAt: null,
});

export const CaseRepositoryTest = Layer.effect(
  CaseRepository,
  Effect.sync(() => {
    const store = new Map<string, Case>();

    return CaseRepository.of({
      create: (input) =>
        Effect.sync(() => {
          const c = buildCase(input, new Date());
          store.set(c.id, c);
          return c;
        }),

      getById: (id) =>
        Effect.suspend((): Effect.Effect<Case, CaseRepositoryError> => {
          const c = store.get(id);
          return c
            ? Effect.succeed(c)
            : Effect.fail(new CaseNotFound({ caseId: id }));
        }),

      findByThreadId: (tenantId, threadId) =>
        Effect.sync(() => {
          for (const c of store.values()) {
            if (c.tenantId === tenantId && c.threadId === threadId) return c;
          }
          return null;
        }),

      update: (id, patch) =>
        Effect.suspend((): Effect.Effect<Case, CaseRepositoryError> => {
          const existing = store.get(id);
          if (!existing) return Effect.fail(new CaseNotFound({ caseId: id }));
          const updated: Case = {
            ...existing,
            ...patch,
            updatedAt: new Date(),
          };
          store.set(id, updated);
          return Effect.succeed(updated);
        }),

      transitionStatus: (id, toStatus, opts = {}) =>
        Effect.suspend((): Effect.Effect<Case, CaseRepositoryError> => {
          const existing = store.get(id);
          if (!existing) return Effect.fail(new CaseNotFound({ caseId: id }));
          if (
            opts.expectedFromStatus !== undefined &&
            existing.status !== opts.expectedFromStatus
          ) {
            return Effect.fail(
              new CaseStateConflict({
                caseId: id,
                expected: opts.expectedFromStatus,
                actual: existing.status,
              }),
            );
          }
          const now = new Date();
          const updated: Case = {
            ...existing,
            status: toStatus,
            updatedAt: now,
            resolvedAt: toStatus === "resolved" ? now : existing.resolvedAt,
          };
          store.set(id, updated);
          return Effect.succeed(updated);
        }),
    });
  }),
);
