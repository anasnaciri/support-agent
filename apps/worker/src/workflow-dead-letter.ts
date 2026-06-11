import { Effect, Layer } from "effect";
import type { DomainEvent } from "@support-agent/agent-core";
import {
  AuditLogService,
  CaseRepository,
  TransactionRunner,
} from "@support-agent/services";
import type { PgBoss } from "./queue.js";
import {
  DEFAULT_WORKFLOW_DEAD_LETTER_QUEUE,
  reviveDomainEvent,
} from "./workflow-queue-live.js";

/**
 * Dead-letter handling for `workflow.events` (audit C1/L11).
 *
 * When a workflow job exhausts its pg-boss retries, the job is copied to
 * this queue. Without a consumer, retry exhaustion is invisible: the case
 * sits in `new`/`in_progress` forever and the customer never hears back.
 * This consumer parks the affected case in `human_takeover` (with an audit
 * row) so the dashboard surfaces it to a person.
 */
export const WORKFLOW_DEAD_LETTER_QUEUE = DEFAULT_WORKFLOW_DEAD_LETTER_QUEUE;

interface DeadLetterJobData {
  readonly eventId: string;
  readonly event: DomainEvent;
  readonly key: string;
  readonly enqueuedAt: string;
}

const eventCaseRef = (
  event: DomainEvent,
):
  | { readonly kind: "case"; readonly caseId: string }
  | {
      readonly kind: "thread";
      readonly tenantId: string;
      readonly threadId: string;
    }
  | { readonly kind: "none" } => {
  switch (event.type) {
    case "customer.replied":
    case "approval.approved":
    case "approval.rejected":
    case "supplier.updated":
    case "timer.expired":
    case "manual.takeover":
    case "case.resumed":
      return { kind: "case", caseId: event.caseId };
    case "message.received":
      return {
        kind: "thread",
        tenantId: event.tenantId,
        threadId: event.threadId,
      };
    case "ticket.created":
    case "tracking.changed":
      return { kind: "none" };
  }
};

/**
 * Park the case referenced by a dead-lettered event in `human_takeover`.
 * Best-effort by design: a failure here must never crash the dead-letter
 * consumer (the job already exhausted its retries once), so every error
 * degrades to a log line. Idempotent: a case already parked (or resolved)
 * is left untouched.
 */
export const escalateDeadLetteredEvent = (
  event: DomainEvent,
): Effect.Effect<
  void,
  never,
  CaseRepository | AuditLogService | TransactionRunner
> =>
  Effect.gen(function* () {
    const cases = yield* CaseRepository;
    const audit = yield* AuditLogService;
    const tx = yield* TransactionRunner;

    const ref = eventCaseRef(event);
    if (ref.kind === "none") {
      yield* Effect.logWarning(
        `[dead-letter] no case reference on ${event.type}; skipping escalation`,
      );
      return;
    }

    const row =
      ref.kind === "case"
        ? yield* cases
            .getById(ref.caseId as never)
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
        : yield* cases
            .findByThreadId(ref.tenantId as never, ref.threadId as never)
            .pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (!row) {
      yield* Effect.logWarning(
        `[dead-letter] case not found for ${event.type}; skipping escalation`,
      );
      return;
    }
    if (row.status === "human_takeover" || row.status === "resolved") {
      return;
    }

    yield* tx
      .run(
        Effect.gen(function* () {
          const updated = yield* cases.transitionStatus(
            row.id,
            "human_takeover",
            { reason: "workflow_retries_exhausted" },
          );
          yield* audit.record({
            tenantId: updated.tenantId,
            caseId: updated.id,
            actor: { type: "system", id: "workflow-dead-letter" },
            action: "case.escalated_to_human",
            details: {
              reason: "workflow_retries_exhausted",
              eventType: event.type,
            },
          });
        }),
      )
      .pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError(
            `[dead-letter] failed to escalate case ${row.id}: ${String(cause)}`,
          ),
        ),
      );
  });

export const registerWorkflowDeadLetterConsumer = async (opts: {
  readonly boss: PgBoss;
  readonly runtimeLayer: Layer.Layer<
    CaseRepository | AuditLogService | TransactionRunner,
    unknown,
    never
  >;
}): Promise<string> => {
  const { boss, runtimeLayer } = opts;
  return boss.work<DeadLetterJobData, void>(
    WORKFLOW_DEAD_LETTER_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        const event = reviveDomainEvent(job.data.event);
        console.warn(
          `[dead-letter] workflow event exhausted retries: ${event.type} eventId=${job.data.eventId} key=${job.data.key}`,
        );
        await Effect.runPromise(
          Effect.provide(
            escalateDeadLetteredEvent(event),
            runtimeLayer,
          ) as Effect.Effect<void, never, never>,
        );
      }
    },
  );
};
