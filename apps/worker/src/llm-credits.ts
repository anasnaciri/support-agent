// ============================================================
// OpenRouter credits-low check
// ============================================================
//
// A tenant on a prepaid OpenRouter key (BYOK) hits a silent cliff at
// zero credits: every tick starts failing and tickets pile up in
// human_takeover. This pass reads each active openrouter key's balance
// from `GET /api/v1/credits` (USD-denominated by the API) and pings the
// merchant ONCE per below-threshold crossing.
//
// The "once" is an `llmCreditsAlertActive` flag in the connector's
// metadata: stamped only after a DELIVERED ping (a merchant who hasn't
// linked Telegram yet still gets the alert on a later pass once they
// do), cleared when the balance recovers above the threshold so the
// next dip alerts again.
//
// Anthropic / OpenAI BYOK keys have no balance API — only openrouter
// rows are checked.

import { Effect, Option } from "effect";
import { TenantId } from "@support-agent/agent-core";
import {
  AccountOpenRouterCredentialStore,
  ConnectorCredentialStore,
  MerchantNotificationService,
  llmCreditsLowNotification,
} from "@support-agent/services";

const OPENROUTER_CREDITS_ENDPOINT = "https://openrouter.ai/api/v1/credits";

export interface CreditsAlertDecision {
  readonly alert: boolean;
  readonly rearm: boolean;
}

/** Pure crossing rule — exported for tests. */
export const decideCreditsAlert = (
  alreadyAlerted: boolean,
  remainingUsd: number,
  thresholdUsd: number,
): CreditsAlertDecision => {
  const below = remainingUsd < thresholdUsd;
  return {
    alert: below && !alreadyAlerted,
    rearm: !below && alreadyAlerted,
  };
};

export type LlmCreditsTarget =
  | {
      readonly scope: "workspace";
      readonly tenantId: string;
      readonly shopDomain: string;
    }
  | {
      readonly scope: "account";
      readonly organizationId: string;
      /** Default workspace used to deliver the merchant notification. */
      readonly tenantId: string;
    };

export interface LlmCreditsDeps {
  readonly thresholdUsd: number;
  /** Override for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface LlmCreditsResult {
  readonly tenantId: string;
  readonly outcome:
    | "ok"
    | "alerted"
    | "already_alerted"
    | "no_channel"
    | "rearmed"
    | { readonly failed: string };
  readonly remainingUsd?: number;
}

const readRemainingUsd = async (
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<number | null> => {
  const res = await fetchImpl(OPENROUTER_CREDITS_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    data?: { total_credits?: unknown; total_usage?: unknown };
  } | null;
  const total = body?.data?.total_credits;
  const usage = body?.data?.total_usage;
  if (typeof total !== "number" || typeof usage !== "number") return null;
  return total - usage;
};

/**
 * Check each target's OpenRouter balance and alert the merchant on a
 * below-threshold crossing. Per-target failures degrade to a `failed`
 * outcome — one tenant's dead key must not starve the others.
 */
export const checkOpenRouterCredits = (
  targets: ReadonlyArray<LlmCreditsTarget>,
  deps: LlmCreditsDeps,
): Effect.Effect<
  ReadonlyArray<LlmCreditsResult>,
  never,
  ConnectorCredentialStore | AccountOpenRouterCredentialStore
> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    const accountStore = yield* AccountOpenRouterCredentialStore;
    const maybeNotifications = yield* Effect.serviceOption(
      MerchantNotificationService,
    );
    const fetchImpl = deps.fetchImpl ?? fetch;
    const results: Array<LlmCreditsResult> = [];

    for (const target of targets) {
      const tenantId = TenantId(target.tenantId);
      let apiKey: string;
      let metadata: Readonly<Record<string, unknown>>;
      if (target.scope === "account") {
        const loaded = yield* accountStore
          .get(target.organizationId)
          .pipe(Effect.either);
        if (loaded._tag === "Left") {
          results.push({
            tenantId: target.tenantId,
            outcome: { failed: loaded.left._tag },
          });
          continue;
        }
        if (!loaded.right || loaded.right.status !== "active") {
          results.push({
            tenantId: target.tenantId,
            outcome: { failed: "credential_missing" },
          });
          continue;
        }
        apiKey = loaded.right.apiKey;
        metadata = loaded.right.metadata;
      } else {
        const loaded = yield* store
          .get(tenantId, "openrouter", target.shopDomain)
          .pipe(Effect.either);
        if (loaded._tag === "Left") {
          results.push({
            tenantId: target.tenantId,
            outcome: { failed: loaded.left._tag },
          });
          continue;
        }
        apiKey = loaded.right.accessToken;
        metadata = loaded.right.metadata;
      }

      const remaining = yield* Effect.promise(() =>
        readRemainingUsd(apiKey, fetchImpl).catch(() => null),
      );
      if (remaining === null) {
        results.push({
          tenantId: target.tenantId,
          outcome: { failed: "credits_unreadable" },
        });
        continue;
      }

      const alreadyAlerted =
        metadata["llmCreditsAlertActive"] === true;
      const decision = decideCreditsAlert(
        alreadyAlerted,
        remaining,
        deps.thresholdUsd,
      );

      if (decision.rearm) {
        if (target.scope === "account") {
          yield* accountStore
            .patchMetadata(target.organizationId, {
              llmCreditsAlertActive: false,
            })
            .pipe(Effect.ignore);
        } else {
          yield* store
            .patchMetadata({
              tenantId,
              provider: "openrouter",
              shopDomain: target.shopDomain,
              metadata: { llmCreditsAlertActive: false },
            })
            .pipe(Effect.ignore);
        }
        results.push({
          tenantId: target.tenantId,
          outcome: "rearmed",
          remainingUsd: remaining,
        });
        continue;
      }

      if (!decision.alert) {
        results.push({
          tenantId: target.tenantId,
          outcome: alreadyAlerted ? "already_alerted" : "ok",
          remainingUsd: remaining,
        });
        continue;
      }

      const delivered = Option.isSome(maybeNotifications)
        ? yield* maybeNotifications.value
            .notify(
              tenantId,
              llmCreditsLowNotification({
                provider: "openrouter",
                remainingUsd: remaining,
                thresholdUsd: deps.thresholdUsd,
              }),
            )
            .pipe(
              Effect.map((r) => r.delivered),
              Effect.catchAll(() => Effect.succeed(false)),
            )
        : false;

      if (!delivered) {
        // No channel (or send failed): leave the flag unset so the next
        // pass retries once the merchant connects a channel.
        results.push({
          tenantId: target.tenantId,
          outcome: "no_channel",
          remainingUsd: remaining,
        });
        continue;
      }

      if (target.scope === "account") {
        yield* accountStore
          .patchMetadata(target.organizationId, {
            llmCreditsAlertActive: true,
          })
          .pipe(Effect.ignore);
      } else {
        yield* store
          .patchMetadata({
            tenantId,
            provider: "openrouter",
            shopDomain: target.shopDomain,
            metadata: { llmCreditsAlertActive: true },
          })
          .pipe(Effect.ignore);
      }
      results.push({
        tenantId: target.tenantId,
        outcome: "alerted",
        remainingUsd: remaining,
      });
    }

    return results;
  });
