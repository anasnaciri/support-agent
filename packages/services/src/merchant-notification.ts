import { Context, Data, Effect, Layer } from "effect";
import type { CaseId, TenantId } from "@support-agent/agent-core";

// ============================================================
// MerchantNotificationService
// ============================================================
//
// Push notifications FROM the platform TO the merchant's operator, over
// whatever chat channel the tenant has connected (Telegram first; the
// master-plan §9 "NotificationService fan-out" envisions Slack/SMS later).
//
// Distinct from the two existing outbound surfaces:
//   - `ConversationService` — tenant mailbox → CUSTOMER. Never used here.
//   - `PlatformMailService` — platform domain → operator EMAIL. Durable,
//     formal (approval links, deletion notices). This service is the
//     lightweight real-time ping next to it.
//
// "No channel connected" is NOT an error: callers are best-effort
// emitters (runtime escalations, crons) or the `merchant.notify` tool,
// which wants to tell the agent the merchant didn't get the ping —
// so it surfaces as `{ delivered: false, channel: null }`.

export type MerchantNotificationKind =
  /** Agent-initiated heads-up via the `merchant.notify` tool. */
  | "agent_note"
  /** A tool call parked the case in `waiting_for_approval`. */
  | "approval_requested"
  /** The case was escalated to `human_takeover`. */
  | "human_takeover"
  /** A connector's health flipped ok → broken. */
  | "connector_broken"
  /** The tenant's metered LLM balance dropped under the alert threshold. */
  | "llm_credits_low";

export interface MerchantNotification {
  readonly kind: MerchantNotificationKind;
  /** Short headline, plain text (channel impls render it as the first line). */
  readonly title: string;
  /** Plain-text body. May contain URLs; channel impls must NOT interpret markup. */
  readonly body: string;
  /** Present when the notification is about a specific case. */
  readonly caseId?: CaseId;
}

export type MerchantNotificationChannel = "telegram";

export interface MerchantNotifyResult {
  readonly delivered: boolean;
  readonly channel: MerchantNotificationChannel | null;
}

export class MerchantNotificationSendFailed extends Data.TaggedError(
  "MerchantNotificationSendFailed",
)<{
  readonly tenantId: TenantId;
  readonly cause: unknown;
}> {}

export class MerchantNotificationService extends Context.Tag(
  "MerchantNotificationService",
)<
  MerchantNotificationService,
  {
    /**
     * Push one notification to the tenant's connected channel.
     * No channel connected → succeeds with `delivered: false` (the
     * caller decides whether that matters); a real transport failure
     * fails with `MerchantNotificationSendFailed`.
     */
    readonly notify: (
      tenantId: TenantId,
      notification: MerchantNotification,
    ) => Effect.Effect<MerchantNotifyResult, MerchantNotificationSendFailed>;
  }
>() {}

// ============================================================
// Test layer
// ============================================================

export interface MerchantNotificationTestRecord {
  readonly tenantId: TenantId;
  readonly notification: MerchantNotification;
  readonly result: MerchantNotifyResult;
}

export interface MerchantNotificationTestHandle {
  /** Every non-failing notify() attempt, including undelivered ones. */
  readonly sent: ReadonlyArray<MerchantNotificationTestRecord>;
}

export interface MerchantNotificationTestFixtures {
  /** When true, every notify fails with MerchantNotificationSendFailed. */
  readonly failAll?: boolean;
  /** Tenants treated as having no connected channel (delivered: false). */
  readonly disconnectedFor?: ReadonlySet<TenantId>;
}

export const makeMerchantNotificationServiceTest = (
  fixtures: MerchantNotificationTestFixtures = {},
): {
  readonly layer: Layer.Layer<MerchantNotificationService>;
  readonly handle: MerchantNotificationTestHandle;
} => {
  const sent: Array<MerchantNotificationTestRecord> = [];
  const layer = Layer.succeed(
    MerchantNotificationService,
    MerchantNotificationService.of({
      notify: (tenantId, notification) =>
        Effect.suspend(
          (): Effect.Effect<
            MerchantNotifyResult,
            MerchantNotificationSendFailed
          > => {
            if (fixtures.failAll) {
              return Effect.fail(
                new MerchantNotificationSendFailed({
                  tenantId,
                  cause: "fixture: failAll",
                }),
              );
            }
            const result: MerchantNotifyResult = fixtures.disconnectedFor?.has(
              tenantId,
            )
              ? { delivered: false, channel: null }
              : { delivered: true, channel: "telegram" };
            sent.push({ tenantId, notification, result });
            return Effect.succeed(result);
          },
        ),
    }),
  );
  const handle: MerchantNotificationTestHandle = {
    get sent() {
      return sent;
    },
  };
  return { layer, handle };
};

/** Layer-only convenience: when the test doesn't need to inspect sends. */
export const MerchantNotificationServiceTest = (
  fixtures: MerchantNotificationTestFixtures = {},
): Layer.Layer<MerchantNotificationService> =>
  makeMerchantNotificationServiceTest(fixtures).layer;
