// ============================================================
// Connector health flag + operator alerting (audit L5)
// ============================================================
//
// When a conversation connector dies (revoked refresh token, lapsed
// Graph subscription, hard IMAP auth failure), inbound customer mail
// silently stops. The renewal/poll crons report each connector's health
// here after every pass:
//
//   - the flag lives in the connector's metadata (`connectorHealth`),
//     where the dashboard's integrations page can render it, and
//   - the operator gets ONE alert email per ok→broken transition (not
//     one per cron pass), via PlatformMailService → Resend.
//
// Everything is best-effort: health bookkeeping must never break the
// renewal loop it observes.

import { Effect } from "effect";
import { TenantId } from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  PlatformMailService,
} from "@support-agent/services";

export type ConnectorHealthState = "ok" | "broken";

export const connectorHealthOf = (
  metadata: Readonly<Record<string, unknown>>,
): ConnectorHealthState =>
  metadata["connectorHealth"] === "broken" ? "broken" : "ok";

export interface HealthDecision {
  readonly patch: Readonly<Record<string, unknown>> | null;
  readonly alert: boolean;
}

/** Pure transition rule — exported for tests. */
export const decideHealthTransition = (
  previous: ConnectorHealthState,
  next: ConnectorHealthState,
  reason: string | null,
  at: Date,
): HealthDecision => {
  if (previous === next) return { patch: null, alert: false };
  if (next === "broken") {
    return {
      patch: {
        connectorHealth: "broken",
        connectorHealthReason: reason,
        connectorHealthAt: at.toISOString(),
      },
      alert: true,
    };
  }
  return {
    patch: {
      connectorHealth: "ok",
      connectorHealthReason: null,
      connectorHealthAt: at.toISOString(),
    },
    alert: false,
  };
};

export interface ReportConnectorHealthInput {
  readonly tenantId: string;
  readonly provider: string;
  readonly mailbox: string;
  /** The connector's CURRENT metadata (previous health is read from it). */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly next: ConnectorHealthState;
  readonly reason?: string | null;
  readonly now?: Date;
}

/**
 * Apply the health transition: patch the connector metadata and send the
 * one-time alert. Best-effort throughout — failures log and move on.
 */
export const reportConnectorHealth = (
  input: ReportConnectorHealthInput,
): Effect.Effect<
  void,
  never,
  ConnectorCredentialStore | PlatformMailService
> =>
  Effect.gen(function* () {
    const decision = decideHealthTransition(
      connectorHealthOf(input.metadata),
      input.next,
      input.reason ?? null,
      input.now ?? new Date(),
    );
    if (!decision.patch) return;

    const store = yield* ConnectorCredentialStore;
    yield* store
      .patchMetadata({
        tenantId: TenantId(input.tenantId),
        provider: input.provider as never,
        shopDomain: input.mailbox,
        metadata: decision.patch,
      })
      .pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning(
            `[connector-health] metadata patch failed for ${input.provider}/${input.mailbox}: ${String(cause)}`,
          ),
        ),
      );

    if (decision.alert) {
      const mail = yield* PlatformMailService;
      yield* mail
        .sendConnectorAlert({
          tenantId: TenantId(input.tenantId),
          provider: input.provider,
          mailbox: input.mailbox,
          reason: input.reason ?? "connector failure",
        })
        .pipe(
          Effect.catchAll((cause) =>
            Effect.logWarning(
              `[connector-health] alert email failed for ${input.provider}/${input.mailbox}: ${String(cause)}`,
            ),
          ),
        );
      // eslint-disable-next-line no-console
      console.warn(
        `[connector-health] ${input.provider}/${input.mailbox} (tenant=${input.tenantId}) marked BROKEN: ${input.reason ?? "unknown"}`,
      );
    }
  });

// ============================================================
// Shared wiring for the renewal/poll crons
// ============================================================

/**
 * Outcome shape every conversation-connector cron already produces
 * (gmail watch renewal, graph subscription renewal, imap poll).
 */
export interface RenewalLikeResult {
  readonly tenantId: string;
  readonly mailbox: string;
  readonly outcome: string | { readonly failed: string } | object;
}

/**
 * Map a cron outcome to a health state. Liveness-proving outcomes
 * ("renewed", "skipped_not_due", a successful poll, …) report ok; a
 * missing refresh token or any failure reports broken. `null` for
 * outcomes that say nothing about connector health.
 */
export const renewalOutcomeHealth = (
  outcome: RenewalLikeResult["outcome"],
): { readonly state: ConnectorHealthState; readonly reason: string | null } | null => {
  if (typeof outcome === "object") {
    if ("failed" in outcome) {
      return { state: "broken", reason: (outcome as { failed: string }).failed };
    }
    // e.g. imap `{ polled: n }` — a successful poll proves liveness.
    return { state: "ok", reason: null };
  }
  if (outcome === "skipped_no_refresh_token") {
    return {
      state: "broken",
      reason: "no refresh token stored — reconnect the mailbox",
    };
  }
  if (outcome === "skipped_no_config") return null;
  // "renewed" | "created" | "skipped_not_due" | "seeded" | …
  return { state: "ok", reason: null };
};

/**
 * Report health for a cron pass's results. Loads each connection to read
 * its previous health flag; every step is best-effort.
 */
export const reportRenewalResultsHealth = (
  provider: string,
  results: ReadonlyArray<RenewalLikeResult>,
): Effect.Effect<
  void,
  never,
  ConnectorCredentialStore | PlatformMailService
> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    for (const r of results) {
      const health = renewalOutcomeHealth(r.outcome);
      if (!health) continue;
      const conn = yield* store
        .get(TenantId(r.tenantId), provider as never, r.mailbox)
        .pipe(Effect.either);
      if (conn._tag === "Left") continue;
      yield* reportConnectorHealth({
        tenantId: r.tenantId,
        provider,
        mailbox: r.mailbox,
        metadata: conn.right.metadata,
        next: health.state,
        reason: health.reason,
      });
    }
  });
