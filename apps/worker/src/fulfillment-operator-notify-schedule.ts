// ============================================================
// Fulfillment partner notification sweep — durable outbox relay (§10)
// ============================================================
//
// The escalation row IS the durable outbox: `notified_at IS NULL` means the
// fulfillmentOperator email hasn't been sent. This cron relays unsent rows through
// PlatformMailService and stamps notified_at on success, or bumps the attempt
// counter on failure (so a transient outage is retried next pass and a hard
// bounce eventually trips the cap). The ticket is durable before any email is
// attempted, so delivery survives a process crash entirely.

import { Effect } from "effect";
import { TicketId, TenantId } from "@support-agent/agent-core";
import {
  DbClient,
  listUnsentFulfillmentOperatorEscalations,
  markFulfillmentOperatorEscalationNotified,
  recordFulfillmentOperatorNotifyFailure,
  type UnsentFulfillmentOperatorEscalation,
} from "@support-agent/db";
import {
  TicketLifecycleWriter,
  PlatformMailService,
  type SendFulfillmentOperatorEscalationInput,
} from "@support-agent/services";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";

export const FULFILLMENT_OPERATOR_NOTIFY_QUEUE = "fulfillment_operator.notify";

/** Every minute — fulfillmentOperator notices aren't urgent, but shouldn't lag much. */
const FULFILLMENT_OPERATOR_NOTIFY_CRON = "* * * * *";
const DEFAULT_LIMIT = 50;
/** Stop retrying a hard-bouncing address after this many attempts. */
const MAX_ATTEMPTS = 6;
export const FULFILLMENT_OPERATOR_UNREACHABLE_FLAG = "fulfillment_operator_unreachable";

export type SendOutcome = "sent" | { readonly error: string };

export const escalateFulfillmentOperatorNotifyFailure = (input: {
  readonly escalation: UnsentFulfillmentOperatorEscalation;
  readonly error: string;
}) =>
  Effect.gen(function* () {
    const lifecycle = yield* TicketLifecycleWriter;
    return yield* lifecycle.escalateToHuman({
      ticketId: TicketId(input.escalation.ticketId),
      tenantId: TenantId(input.escalation.tenantId),
      actor: { type: "system", id: "fulfillment-operator-notify" },
      reason: FULFILLMENT_OPERATOR_UNREACHABLE_FLAG,
      riskFlag: FULFILLMENT_OPERATOR_UNREACHABLE_FLAG,
      onlyFromStatus: "waiting_for_fulfillment_operator",
      details: {
        escalationId: input.escalation.id,
        fulfillmentOperatorEmail: input.escalation.fulfillmentOperatorEmail,
        error: input.error,
      },
    });
  });

/**
 * Dependency-injected sweep core — pure async over its deps, so it unit-tests
 * with in-memory fakes (no DB, no Effect layer). The register function wires
 * the real deps from DbClient + PlatformMailService.
 */
export interface FulfillmentOperatorNotifyDeps {
  readonly listUnsent: () => Promise<ReadonlyArray<UnsentFulfillmentOperatorEscalation>>;
  readonly send: (input: SendFulfillmentOperatorEscalationInput) => Promise<SendOutcome>;
  readonly markNotified: (id: string) => Promise<void>;
  readonly recordFailure: (id: string, error: string) => Promise<void>;
  readonly abandonFailure: (
    escalation: UnsentFulfillmentOperatorEscalation,
    error: string,
  ) => Promise<void>;
  readonly maxAttempts: number;
  /** Portal base URL for the deep link, or null to omit it. */
  readonly portalBaseUrl: string | null;
}

export const fireFulfillmentOperatorNotificationsOnce = async (
  deps: FulfillmentOperatorNotifyDeps,
): Promise<{
  readonly sent: number;
  readonly failed: number;
  readonly abandoned: number;
}> => {
  const unsent = await deps.listUnsent();
  let sent = 0;
  let failed = 0;
  let abandoned = 0;
  for (const esc of unsent) {
    const outcome = await deps.send({
      tenantId: TenantId(esc.tenantId),
      escalationId: esc.id,
      fulfillmentOperatorEmail: esc.fulfillmentOperatorEmail,
      // ?w pins the workspace so a fulfillment partner serving several merchants lands on
      // the right one (their active workspace may be a different merchant).
      portalUrl: deps.portalBaseUrl
        ? `${deps.portalBaseUrl}/fulfillment-operator/tickets/${esc.id}?w=${esc.tenantId}`
        : null,
      problem: esc.problem,
      orderRef: esc.orderRef,
    });
    if (outcome === "sent") {
      await deps.markNotified(esc.id);
      sent += 1;
    } else {
      if (esc.notifyAttempts + 1 >= deps.maxAttempts) {
        await deps.abandonFailure(esc, outcome.error);
        abandoned += 1;
      } else {
        await deps.recordFailure(esc.id, outcome.error);
      }
      failed += 1;
    }
  }
  return { sent, failed, abandoned };
};

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  /** Public dashboard URL for the portal deep link (null → omit the link). */
  readonly portalBaseUrl?: string | null;
  readonly cron?: string;
  readonly limit?: number;
}

export const registerFulfillmentOperatorNotifySweep = async (
  opts: RegisterOptions,
): Promise<void> => {
  await opts.boss.createQueue(FULFILLMENT_OPERATOR_NOTIFY_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryBackoff: true,
  });
  await opts.boss.schedule(
    FULFILLMENT_OPERATOR_NOTIFY_QUEUE,
    opts.cron ?? FULFILLMENT_OPERATOR_NOTIFY_CRON,
    {},
    { tz: "UTC" },
  );

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const portalBaseUrl = opts.portalBaseUrl ?? null;

  await opts.boss.work<Record<string, never>, void>(
    FULFILLMENT_OPERATOR_NOTIFY_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const result = await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const db = yield* DbClient;
              const mail = yield* PlatformMailService;
              return yield* Effect.promise(() =>
                fireFulfillmentOperatorNotificationsOnce({
                  portalBaseUrl,
                  listUnsent: () =>
                    listUnsentFulfillmentOperatorEscalations(db, limit, MAX_ATTEMPTS),
                  send: (input) =>
                    Effect.runPromise(
                      mail.sendFulfillmentOperatorEscalation(input).pipe(
                        Effect.map((): SendOutcome => "sent"),
                        Effect.catchAll((e) =>
                          Effect.succeed({ error: String(e) } as SendOutcome),
                        ),
                      ),
                    ),
                  markNotified: (id) => markFulfillmentOperatorEscalationNotified(db, id),
                  recordFailure: (id, err) =>
                    recordFulfillmentOperatorNotifyFailure(db, id, err),
                  abandonFailure: async (escalation, err) => {
                    await Effect.runPromise(
                      Effect.provide(
                        escalateFulfillmentOperatorNotifyFailure({
                          escalation,
                          error: err,
                        }),
                        opts.runtimeLayer,
                      ),
                    );
                    try {
                      await recordFulfillmentOperatorNotifyFailure(db, escalation.id, err);
                    } catch (cause) {
                      // The ticket is already merchant-visible. Keep the pass alive;
                      // the waiting_for_fulfillment_operator filter prevents another send.
                      // eslint-disable-next-line no-console
                      console.error(
                        "[fulfillment-operator-notify] failed to stamp abandoned notification:",
                        cause,
                      );
                    }
                  },
                  maxAttempts: MAX_ATTEMPTS,
                }),
              );
            }),
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause(
              (
                cause,
              ): Effect.Effect<{
                readonly sent: number;
                readonly failed: number;
                readonly abandoned: number;
              }> => {
                // eslint-disable-next-line no-console
                console.error("[fulfillment-operator-notify] pass crashed:", cause);
                return Effect.succeed({ sent: 0, failed: 0, abandoned: 0 });
              },
            ),
          ),
        );
        // eslint-disable-next-line no-console
        console.log(
          `[fulfillment-operator-notify] pass complete: sent=${result.sent} failed=${result.failed} abandoned=${result.abandoned}`,
        );
      }
    },
  );
};
