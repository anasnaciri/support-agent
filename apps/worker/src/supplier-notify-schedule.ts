// ============================================================
// Supplier notification sweep — durable outbox relay (§10)
// ============================================================
//
// The escalation row IS the durable outbox: `notified_at IS NULL` means the
// supplier email hasn't been sent. This cron relays unsent rows through
// PlatformMailService and stamps notified_at on success, or bumps the attempt
// counter on failure (so a transient outage is retried next pass and a hard
// bounce eventually trips the cap). The case is durable before any email is
// attempted, so delivery survives a process crash entirely.

import { Effect } from "effect";
import { CaseId, TenantId } from "@support-agent/agent-core";
import {
  DbClient,
  listUnsentSupplierEscalations,
  markSupplierEscalationNotified,
  recordSupplierNotifyFailure,
  type UnsentSupplierEscalation,
} from "@support-agent/db";
import {
  AuditLogService,
  CaseRepository,
  PlatformMailService,
  TransactionRunner,
  type SendSupplierEscalationInput,
} from "@support-agent/services";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";

export const SUPPLIER_NOTIFY_QUEUE = "supplier.notify";

/** Every minute — supplier notices aren't urgent, but shouldn't lag much. */
const SUPPLIER_NOTIFY_CRON = "* * * * *";
const DEFAULT_LIMIT = 50;
/** Stop retrying a hard-bouncing address after this many attempts. */
const MAX_ATTEMPTS = 6;
export const SUPPLIER_UNREACHABLE_FLAG = "supplier_unreachable";

export type SendOutcome = "sent" | { readonly error: string };

const readRiskFlags = (
  context: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> =>
  Array.isArray(context["riskFlags"])
    ? context["riskFlags"].filter((f): f is string => typeof f === "string")
    : [];

export const escalateSupplierNotifyFailure = (input: {
  readonly escalation: UnsentSupplierEscalation;
  readonly error: string;
}) =>
  Effect.gen(function* () {
    const cases = yield* CaseRepository;
    const audit = yield* AuditLogService;
    const tx = yield* TransactionRunner;
    return yield* tx.run(
      Effect.gen(function* () {
        const current = yield* cases.getById(
          CaseId(input.escalation.caseId),
          TenantId(input.escalation.tenantId),
        );
        if (current.status !== "waiting_for_supplier") {
          return current;
        }
        const existing = readRiskFlags(current.context);
        if (!existing.includes(SUPPLIER_UNREACHABLE_FLAG)) {
          yield* cases.update(
            current.id,
            {
              context: {
                ...current.context,
                riskFlags: [...existing, SUPPLIER_UNREACHABLE_FLAG],
              },
            },
            current.tenantId,
          );
        }
        const updated = yield* cases.transitionStatus(
          current.id,
          "human_takeover",
          {
            tenantId: current.tenantId,
            reason: SUPPLIER_UNREACHABLE_FLAG,
          },
        );
        yield* audit.record({
          tenantId: updated.tenantId,
          caseId: updated.id,
          actor: { type: "system", id: "supplier-notify" },
          action: "case.escalated_to_human",
          details: {
            reason: SUPPLIER_UNREACHABLE_FLAG,
            escalationId: input.escalation.id,
            supplierEmail: input.escalation.supplierEmail,
            error: input.error,
          },
        });
        return updated;
      }),
    );
  });

/**
 * Dependency-injected sweep core — pure async over its deps, so it unit-tests
 * with in-memory fakes (no DB, no Effect layer). The register function wires
 * the real deps from DbClient + PlatformMailService.
 */
export interface SupplierNotifyDeps {
  readonly listUnsent: () => Promise<ReadonlyArray<UnsentSupplierEscalation>>;
  readonly send: (input: SendSupplierEscalationInput) => Promise<SendOutcome>;
  readonly markNotified: (id: string) => Promise<void>;
  readonly recordFailure: (id: string, error: string) => Promise<void>;
  readonly abandonFailure: (
    escalation: UnsentSupplierEscalation,
    error: string,
  ) => Promise<void>;
  readonly maxAttempts: number;
  /** Portal base URL for the deep link, or null to omit it. */
  readonly portalBaseUrl: string | null;
}

export const fireSupplierNotificationsOnce = async (
  deps: SupplierNotifyDeps,
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
      supplierEmail: esc.supplierEmail,
      portalUrl: deps.portalBaseUrl
        ? `${deps.portalBaseUrl}/supplier/cases/${esc.id}`
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

export const registerSupplierNotifySweep = async (
  opts: RegisterOptions,
): Promise<void> => {
  await opts.boss.createQueue(SUPPLIER_NOTIFY_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryBackoff: true,
  });
  await opts.boss.schedule(
    SUPPLIER_NOTIFY_QUEUE,
    opts.cron ?? SUPPLIER_NOTIFY_CRON,
    {},
    { tz: "UTC" },
  );

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const portalBaseUrl = opts.portalBaseUrl ?? null;

  await opts.boss.work<Record<string, never>, void>(
    SUPPLIER_NOTIFY_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const result = await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const db = yield* DbClient;
              const mail = yield* PlatformMailService;
              return yield* Effect.promise(() =>
                fireSupplierNotificationsOnce({
                  portalBaseUrl,
                  listUnsent: () =>
                    listUnsentSupplierEscalations(db, limit, MAX_ATTEMPTS),
                  send: (input) =>
                    Effect.runPromise(
                      mail.sendSupplierEscalation(input).pipe(
                        Effect.map((): SendOutcome => "sent"),
                        Effect.catchAll((e) =>
                          Effect.succeed({ error: String(e) } as SendOutcome),
                        ),
                      ),
                    ),
                  markNotified: (id) => markSupplierEscalationNotified(db, id),
                  recordFailure: (id, err) =>
                    recordSupplierNotifyFailure(db, id, err),
                  abandonFailure: async (escalation, err) => {
                    await Effect.runPromise(
                      Effect.provide(
                        escalateSupplierNotifyFailure({
                          escalation,
                          error: err,
                        }),
                        opts.runtimeLayer,
                      ),
                    );
                    try {
                      await recordSupplierNotifyFailure(db, escalation.id, err);
                    } catch (cause) {
                      // The case is already merchant-visible. Keep the pass alive;
                      // the waiting_for_supplier filter prevents another send.
                      // eslint-disable-next-line no-console
                      console.error(
                        "[supplier-notify] failed to stamp abandoned notification:",
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
                console.error("[supplier-notify] pass crashed:", cause);
                return Effect.succeed({ sent: 0, failed: 0, abandoned: 0 });
              },
            ),
          ),
        );
        // eslint-disable-next-line no-console
        console.log(
          `[supplier-notify] pass complete: sent=${result.sent} failed=${result.failed} abandoned=${result.abandoned}`,
        );
      }
    },
  );
};
