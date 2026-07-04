// ============================================================
// Reply-delivery retry sweep — durable outbox relay for failed sends
// ============================================================
//
// The `reply_deliveries` row IS the durable outbox: a `pending` row whose
// `next_attempt_at` is due means a customer reply failed to send and is owed a
// retry. This cron re-sends due rows through the SAME connector
// (ConversationService) with the verbatim draft — no LLM re-run — and:
//   - on success: marks the row `sent` and AUTO-RESOLVES the ticket (it was
//     parked in human_takeover when the send first failed);
//   - on failure under the attempt cap: bumps the attempt + reschedules with
//     exponential backoff;
//   - at the cap: marks the row `abandoned` and leaves the ticket in
//     human_takeover for a person.
//
// A guard skips re-sending when the ticket is no longer `human_takeover` (a human
// handed it back or resolved it) so the auto-retry never races a manual reply.

import { Effect } from "effect";
import {
  TicketId,
  TenantId,
  ThreadId,
  type MessageParticipant,
} from "@support-agent/agent-core";
import {
  DbClient,
  abandonReplyDelivery,
  listDueReplyDeliveries,
  markReplyDeliverySent,
  recordReplyDeliveryFailure,
  type DueReplyDelivery,
} from "@support-agent/db";
import {
  TicketLifecycleWriter,
  TicketRepository,
  ConversationService,
  REPLY_DELIVERY_FAILED_FLAG,
  nextReplyDeliveryBackoffMs,
} from "@support-agent/services";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";

export const REPLY_DELIVERY_RETRY_QUEUE = "reply.delivery.retry";

/** Every minute — a failed reply should reach the customer as soon as it can. */
const REPLY_DELIVERY_RETRY_CRON = "* * * * *";
const DEFAULT_LIMIT = 50;

export type ReplySendOutcome = "sent" | "skip" | { readonly error: string };

/**
 * Dependency-injected sweep core — pure async over its deps, so it unit-tests
 * with in-memory fakes (no DB, no Effect layer). `recordFailure` receives the
 * NEXT attempt number; the register wiring turns it into a backoff timestamp.
 */
export interface ReplyDeliveryRetryDeps {
  readonly listDue: () => Promise<ReadonlyArray<DueReplyDelivery>>;
  readonly send: (d: DueReplyDelivery) => Promise<ReplySendOutcome>;
  readonly markSent: (id: string) => Promise<void>;
  readonly resolveTicket: (ticketId: string, tenantId: string) => Promise<void>;
  readonly recordFailure: (
    id: string,
    error: string,
    nextAttempt: number,
  ) => Promise<void>;
  readonly abandon: (id: string, error: string) => Promise<void>;
}

export const fireReplyDeliveryRetryOnce = async (
  deps: ReplyDeliveryRetryDeps,
): Promise<{
  readonly sent: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly skipped: number;
}> => {
  const due = await deps.listDue();
  let sent = 0;
  let failed = 0;
  let abandoned = 0;
  let skipped = 0;
  for (const d of due) {
    const outcome = await deps.send(d);
    if (outcome === "sent") {
      await deps.markSent(d.id);
      await deps.resolveTicket(d.ticketId, d.tenantId);
      sent += 1;
    } else if (outcome === "skip") {
      // The ticket is no longer parked on this delivery — stop retrying without
      // resolving (a human took it over / already resolved it).
      await deps.markSent(d.id);
      skipped += 1;
    } else if (d.attempts + 1 >= d.maxAttempts) {
      await deps.abandon(d.id, outcome.error);
      abandoned += 1;
    } else {
      await deps.recordFailure(d.id, outcome.error, d.attempts + 1);
      failed += 1;
    }
  }
  return { sent, failed, abandoned, skipped };
};

// ------------------------------------------------------------
// Effectful pieces (re-send via the connector; auto-resolve on success)
// ------------------------------------------------------------

const participantsOf = (raw: unknown): ReadonlyArray<MessageParticipant> =>
  Array.isArray(raw)
    ? raw
        .filter(
          (p): p is { name?: unknown; email?: unknown } =>
            !!p && typeof p === "object",
        )
        .map((p) => ({
          name: typeof p.name === "string" ? p.name : null,
          email: typeof p.email === "string" ? p.email : "",
        }))
    : [];

/** Re-send a stored draft through the connector. Returns the send outcome. */
const reSendEffect = (
  d: DueReplyDelivery,
): Effect.Effect<ReplySendOutcome, never, ConversationService | TicketRepository> =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    // Guard: only auto-retry while the ticket is still parked on this failure.
    const current = yield* tickets
      .getById(TicketId(d.ticketId), TenantId(d.tenantId))
      .pipe(Effect.either);
    if (current._tag === "Left") return "skip" as const;
    if (current.right.status !== "human_takeover") return "skip" as const;

    const convo = yield* ConversationService;
    const draft = (d.draft ?? {}) as Record<string, unknown>;
    const base = {
      threadId: ThreadId(String(draft["threadId"] ?? "")),
      ...(d.mailbox ? { mailbox: d.mailbox } : {}),
      to: participantsOf(draft["to"]),
      subject:
        typeof draft["subject"] === "string"
          ? (draft["subject"] as string)
          : null,
      bodyText: typeof draft["bodyText"] === "string" ? (draft["bodyText"] as string) : "",
      bodyHtml:
        typeof draft["bodyHtml"] === "string" ? (draft["bodyHtml"] as string) : null,
      attachments: [],
      draftId: String(draft["draftId"] ?? d.draftId),
    };
    const send =
      d.tool === "conversation.ask_customer"
        ? convo.askCustomer(TenantId(d.tenantId), base)
        : convo.reply(TenantId(d.tenantId), {
            ...base,
            inReplyToMessageId:
              typeof draft["inReplyToMessageId"] === "string"
                ? (draft["inReplyToMessageId"] as string)
                : null,
          });
    return yield* send.pipe(
      Effect.map((): ReplySendOutcome => "sent"),
      Effect.catchAll((e) =>
        Effect.succeed({
          error:
            (e as { _tag?: unknown })._tag &&
            typeof (e as { _tag?: unknown })._tag === "string"
              ? String((e as { _tag: string })._tag)
              : String(e),
        } as ReplySendOutcome),
      ),
    );
  });

/**
 * Auto-resolve a ticket whose reply finally delivered: clear the
 * `reply_delivery_failed` flag and move it to `resolved` (via `in_progress`
 * when it's still parked in `human_takeover`, which can't go straight to
 * resolved). Skips a ticket that's already resolved.
 */
const resolveDeliveredEffect = (
  ticketId: string,
  tenantId: string,
): Effect.Effect<void, never, TicketLifecycleWriter> =>
  Effect.gen(function* () {
    const lifecycle = yield* TicketLifecycleWriter;
    yield* lifecycle
      .resolve({
        ticketId: TicketId(ticketId),
        tenantId: TenantId(tenantId),
        actor: { type: "system", id: "reply-delivery-retry" },
        reason: "reply delivered on retry",
        bridgeFromHumanTakeover: true,
        clearRiskFlags: [REPLY_DELIVERY_FAILED_FLAG],
        details: { reason: "reply_delivered_on_retry" },
      })
      .pipe(Effect.asVoid, Effect.catchAll(() => Effect.void));
  });

// ------------------------------------------------------------
// Registration
// ------------------------------------------------------------

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  readonly cron?: string;
  readonly limit?: number;
}

export const registerReplyDeliveryRetrySweep = async (
  opts: RegisterOptions,
): Promise<void> => {
  await opts.boss.createQueue(REPLY_DELIVERY_RETRY_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryBackoff: true,
  });
  await opts.boss.schedule(
    REPLY_DELIVERY_RETRY_QUEUE,
    opts.cron ?? REPLY_DELIVERY_RETRY_CRON,
    {},
    { tz: "UTC" },
  );

  const limit = opts.limit ?? DEFAULT_LIMIT;

  await opts.boss.work<Record<string, never>, void>(
    REPLY_DELIVERY_RETRY_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const result = await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const db = yield* DbClient;
              const runSend = (d: DueReplyDelivery) =>
                Effect.runPromise(Effect.provide(reSendEffect(d), opts.runtimeLayer));
              const runResolve = (ticketId: string, tenantId: string) =>
                Effect.runPromise(
                  Effect.provide(
                    resolveDeliveredEffect(ticketId, tenantId),
                    opts.runtimeLayer,
                  ),
                );
              return yield* Effect.promise(() =>
                fireReplyDeliveryRetryOnce({
                  listDue: () => listDueReplyDeliveries(db, new Date(), limit),
                  send: runSend,
                  markSent: (id) => markReplyDeliverySent(db, id),
                  resolveTicket: runResolve,
                  recordFailure: (id, err, attempt) =>
                    recordReplyDeliveryFailure(
                      db,
                      id,
                      err,
                      new Date(Date.now() + nextReplyDeliveryBackoffMs(attempt)),
                    ),
                  abandon: (id, err) => abandonReplyDelivery(db, id, err),
                }),
              );
            }),
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause((cause) => {
              // eslint-disable-next-line no-console
              console.error("[reply-delivery-retry] pass crashed:", cause);
              return Effect.succeed({
                sent: 0,
                failed: 0,
                abandoned: 0,
                skipped: 0,
              });
            }),
          ),
        );
        // eslint-disable-next-line no-console
        console.log(
          `[reply-delivery-retry] pass complete: sent=${result.sent} failed=${result.failed} abandoned=${result.abandoned} skipped=${result.skipped}`,
        );
      }
    },
  );
};
