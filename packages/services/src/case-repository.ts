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
  isStatusTransitionAllowed,
} from "@support-agent/agent-core";
import {
  parseThreadId,
  type ConversationProviderId,
} from "./conversation-thread-id.js";

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

/**
 * The requested status change violates the case state machine
 * (master-plan §10, audit L1) — e.g. resolving a case a manager has
 * taken over. Callers re-read the case and respect the current owner.
 */
export class InvalidStatusTransition extends Data.TaggedError(
  "InvalidStatusTransition",
)<{
  readonly caseId: CaseId;
  readonly from: CaseStatus;
  readonly to: CaseStatus;
}> {}

export type CaseRepositoryError =
  | CaseNotFound
  | CaseStateConflict
  | InvalidStatusTransition
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
  /** Exact connected mailbox that owns `threadId`. */
  readonly mailbox?: string | null;
  /**
   * Conversation connector that owns `threadId` (audit D2). When omitted it
   * is derived from a provider-namespaced `threadId` (`gmail:…`); pass it
   * explicitly when the inbound edge knows the provider (always preferred).
   */
  readonly provider?: ConversationProviderId | null;
  readonly category?: string | null;
  readonly priority?: CasePriority;
  readonly status?: CaseStatus;
  readonly subject?: string | null;
  readonly summary?: string | null;
  readonly context?: CaseContext;
}

/**
 * Provider stamp for a new case: the explicit input wins; otherwise it is
 * derived from a namespaced threadId. Shared by the Live and Test impls so
 * they can't drift.
 */
export const resolveCaseProvider = (
  input: Pick<CreateCaseInput, "provider" | "threadId">,
): ConversationProviderId | null => {
  if (input.provider !== undefined && input.provider !== null) {
    return input.provider;
  }
  if (input.threadId) return parseThreadId(input.threadId)?.provider ?? null;
  return null;
};

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
    | "mailbox"
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
  /**
   * Defense-in-depth tenant scope (audit D9): when present, a case outside
   * the tenant is treated as not found and nothing is written.
   */
  readonly tenantId?: TenantId;
}

// ============================================================
// Tag
// ============================================================

/**
 * `tenantId` on the bare-id methods (`getById`/`update`/`transitionStatus`
 * via opts) is OPTIONAL for caller compatibility but ENFORCED when present
 * (audit D9): a case that exists under another tenant behaves exactly like
 * a missing case (`CaseNotFound`), disclosure-safe. New callers should
 * always pass it.
 */
export class CaseRepository extends Context.Tag("CaseRepository")<
  CaseRepository,
  {
    readonly create: (
      input: CreateCaseInput,
    ) => Effect.Effect<Case, CaseRepositoryError>;

    readonly getById: (
      id: CaseId,
      tenantId?: TenantId,
    ) => Effect.Effect<Case, CaseRepositoryError>;

    readonly findByThreadId: (
      tenantId: TenantId,
      threadId: ThreadId,
      /** When present, only a case stamped with this provider matches (D2). */
      provider?: ConversationProviderId,
      /** When present, only the case owned by this mailbox matches. */
      mailbox?: string,
    ) => Effect.Effect<Case | null, CaseRepositoryError>;

    /**
     * The conversation provider stamped on the case holding `threadId`, or
     * null when the case is missing or unstamped (legacy). Lets the
     * conversation router dispatch legacy (un-namespaced) thread ids by the
     * case's own stamp instead of guessing tenant-wide (audit D2).
     */
    readonly findThreadProvider: (
      tenantId: TenantId,
      threadId: ThreadId,
    ) => Effect.Effect<ConversationProviderId | null, CaseRepositoryError>;

    readonly update: (
      id: CaseId,
      patch: UpdatableCaseFields,
      tenantId?: TenantId,
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
  mailbox: input.mailbox ?? null,
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
    // Provider stamp lives off to the side: the `Case` domain type doesn't
    // carry it (it's routing metadata, not agent-visible state).
    const providerOf = new Map<string, ConversationProviderId | null>();

    // D9: enforce the optional tenant scope exactly like the Live impl — a
    // case under another tenant is indistinguishable from a missing one.
    const scoped = (id: CaseId, tenantId?: TenantId): Case | null => {
      const c = store.get(id);
      if (!c) return null;
      if (tenantId !== undefined && c.tenantId !== tenantId) return null;
      return c;
    };

    return CaseRepository.of({
      create: (input) =>
        Effect.sync(() => {
          const c = buildCase(input, new Date());
          store.set(c.id, c);
          providerOf.set(c.id, resolveCaseProvider(input));
          return c;
        }),

      getById: (id, tenantId) =>
        Effect.suspend((): Effect.Effect<Case, CaseRepositoryError> => {
          const c = scoped(id, tenantId);
          return c
            ? Effect.succeed(c)
            : Effect.fail(new CaseNotFound({ caseId: id }));
        }),

      findByThreadId: (tenantId, threadId, provider, mailbox) =>
        Effect.sync(() => {
          for (const c of store.values()) {
            if (c.tenantId !== tenantId || c.threadId !== threadId) continue;
            if (provider !== undefined && providerOf.get(c.id) !== provider) {
              continue;
            }
            if (mailbox !== undefined && c.mailbox !== mailbox) continue;
            return c;
          }
          return null;
        }),

      findThreadProvider: (tenantId, threadId) =>
        Effect.sync(() => {
          for (const c of store.values()) {
            if (c.tenantId === tenantId && c.threadId === threadId) {
              return providerOf.get(c.id) ?? null;
            }
          }
          return null;
        }),

      update: (id, patch, tenantId) =>
        Effect.suspend((): Effect.Effect<Case, CaseRepositoryError> => {
          const existing = scoped(id, tenantId);
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
          const existing = scoped(id, opts.tenantId);
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
          // Master-plan §10 (audit L1): every status write obeys the
          // transition matrix — Test and Live enforce identically.
          if (!isStatusTransitionAllowed(existing.status, toStatus)) {
            return Effect.fail(
              new InvalidStatusTransition({
                caseId: id,
                from: existing.status,
                to: toStatus,
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
