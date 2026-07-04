import { Effect, Layer, Option } from "effect";
import type { DomainEvent } from "@support-agent/agent-core";
import {
  CaseLifecycleWriter,
  CaseRepository,
  MerchantNotificationService,
  humanTakeoverNotification,
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
      readonly mailbox: string | undefined;
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
        mailbox: event.payload.mailbox,
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
  underlyingError?: string,
): Effect.Effect<
  void,
  never,
  CaseRepository | CaseLifecycleWriter
> =>
  Effect.gen(function* () {
    const cases = yield* CaseRepository;
    const lifecycle = yield* CaseLifecycleWriter;

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
            .findByThreadId(
              ref.tenantId as never,
              ref.threadId as never,
              undefined,
              ref.mailbox,
            )
            .pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (!row) {
      yield* Effect.logWarning(
        `[dead-letter] case not found for ${event.type}; skipping escalation`,
      );
      return;
    }
    if (
      row.status === "human_takeover" ||
      row.status === "resolved" ||
      row.status === "archived"
    ) {
      return;
    }

    const parked = yield* lifecycle
      .escalateToHuman({
        caseId: row.id,
        tenantId: row.tenantId,
        actor: { type: "system", id: "workflow-dead-letter" },
        reason: "workflow_retries_exhausted",
        details: {
          eventType: event.type,
          // The underlying tick error that exhausted the retries (e.g.
          // "llm transient error: ProviderUnavailable"). pg-boss copies the
          // last failed attempt's serialized error into the dead-letter job's
          // `output`; surfacing it here is the only durable record — the
          // worker's stdout has rotated by the time anyone looks.
          ...(underlyingError
            ? { underlyingError: underlyingError.slice(0, 500) }
            : {}),
        },
      })
      .pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError(
            `[dead-letter] failed to escalate case ${row.id}: ${String(cause)}`,
          ).pipe(Effect.as(null)),
        ),
      );

    // Ping the merchant once the park committed. Optional service +
    // best-effort, like everything else in this consumer.
    if (parked) {
      const maybeNotifications = yield* Effect.serviceOption(
        MerchantNotificationService,
      );
      if (Option.isSome(maybeNotifications)) {
        yield* maybeNotifications.value
          .notify(
            parked.tenantId,
            humanTakeoverNotification({
              caseId: parked.id,
              subject: parked.subject,
              reason: "workflow_retries_exhausted",
            }),
          )
          .pipe(Effect.ignore);
      }
    }
  });

export const registerWorkflowDeadLetterConsumer = async (opts: {
  readonly boss: PgBoss;
  readonly runtimeLayer: Layer.Layer<
    CaseRepository | CaseLifecycleWriter,
    unknown,
    never
  >;
}): Promise<string> => {
  const { boss, runtimeLayer } = opts;
  // `includeMetadata: true` makes pg-boss return the job's `output` column —
  // for a dead-lettered job that's the serialized error from the last failed
  // attempt (pg-boss copies it across when dead-lettering). We thread its
  // message into the escalation audit so the cause is recoverable.
  return boss.work<DeadLetterJobData, void>(
    WORKFLOW_DEAD_LETTER_QUEUE,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        const event = reviveDomainEvent(job.data.event);
        const underlyingError = extractOutputMessage(
          (job as { output?: unknown }).output,
        );
        console.warn(
          `[dead-letter] workflow event exhausted retries: ${event.type} eventId=${job.data.eventId} key=${job.data.key} reason=${underlyingError ?? "unknown"}`,
        );
        await Effect.runPromise(
          Effect.provide(
            escalateDeadLetteredEvent(event, underlyingError),
            runtimeLayer,
          ) as Effect.Effect<void, never, never>,
        );
      }
    },
  );
};

/**
 * Pull a human-readable message out of a pg-boss job `output`. A handler that
 * threw is serialized by `serialize-error` to `{ name, message, stack }`; a
 * non-Error throw is wrapped as `{ value }`. Returns undefined when there's
 * nothing useful (so the escalation omits the field rather than logging noise).
 */
const extractOutputMessage = (output: unknown): string | undefined => {
  if (!output || typeof output !== "object") return undefined;
  const o = output as { message?: unknown; value?: unknown };
  if (typeof o.message === "string" && o.message.length > 0) return o.message;
  if (typeof o.value === "string" && o.value.length > 0) return o.value;
  return undefined;
};
