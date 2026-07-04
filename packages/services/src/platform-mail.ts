import { Context, Data, Effect, Layer } from "effect";
import type { TenantId, ApprovalId } from "@support-agent/agent-core";

// ============================================================
// PlatformMailService
// ============================================================
//
// Outbound mail sent FROM the platform TO the merchant's operator.
// Examples: approval-link emails, manager invites, billing notices.
//
// This is intentionally distinct from `ConversationService`, which
// sends FROM the tenant's connected mailbox TO their customers. Mixing
// them would (a) pollute the customer-support inbox with platform-
// internal mail, (b) make any human reply land back in the runtime as
// a fake customer message, and (c) burn the tenant's per-mailbox send
// quota on platform mail. See memory `feedback_email_inbound_vs_outbound`.

export class PlatformMailUnconfigured extends Data.TaggedError(
  "PlatformMailUnconfigured",
)<{
  readonly tenantId: TenantId;
}> {}

export class PlatformMailSendFailed extends Data.TaggedError(
  "PlatformMailSendFailed",
)<{
  readonly tenantId: TenantId;
  readonly cause: unknown;
}> {}

export type PlatformMailError =
  | PlatformMailUnconfigured
  | PlatformMailSendFailed;

export interface SendApprovalLinkInput {
  readonly tenantId: TenantId;
  readonly approvalId: ApprovalId;
  /** Subject of the draft reply the operator is being asked to approve. */
  readonly draftSubject: string | null;
  /** First ~200 chars of the draft body; renders inside the approval email. */
  readonly draftPreview: string;
  /** What tool is being approved — surfaced in the email subject + body. */
  readonly toolName: string;
  /** Fully-qualified one-click approve URL (already signed). */
  readonly approveUrl: string;
  /** Fully-qualified one-click reject URL (already signed). */
  readonly rejectUrl: string;
}

export interface SendAccountDeletedInput {
  readonly tenantId: TenantId;
  /** Display name of the deleted tenant, for the email body. */
  readonly tenantName: string;
  /**
   * Recipient address. Unlike `sendApprovalLink`, this is passed in
   * directly rather than resolved from `TenantRepository`: by the time
   * the deletion-cleanup job runs, the tenant row is already gone, so the
   * api captures the notification email BEFORE the wipe and hands it here.
   */
  readonly recipientEmail: string;
}

export interface SendConnectorAlertInput {
  readonly tenantId: TenantId;
  readonly provider: string;
  /** Mailbox / shop the connector is bound to, for the email body. */
  readonly mailbox: string;
  /** Human-readable failure description (e.g. "refresh token revoked"). */
  readonly reason: string;
}

export interface SendMerchantNotificationInput {
  readonly tenantId: TenantId;
  /** One-line headline (the agent's `merchant.notify` title, or an emitter's). */
  readonly title: string;
  /** Plain-text body (1–3 sentences). May contain URLs; never customer PII. */
  readonly body: string;
  /** Present when the ping is about a specific ticket (rendered as a reference). */
  readonly ticketId?: string;
}

export interface SendSupplierEscalationInput {
  readonly tenantId: TenantId;
  /** The escalation id — for a stable Resend idempotency key. */
  readonly escalationId: string;
  /**
   * The supplier's email — passed directly (not resolved from the tenant's
   * notificationEmail like the approval/connector mail), because the recipient
   * is the external supplier, not the merchant operator.
   */
  readonly supplierEmail: string;
  /** Deep link to the supplier's ticket in the portal, or null if unconfigured. */
  readonly portalUrl: string | null;
  /** The agent's PII-free problem statement (never carries customer data). */
  readonly problem: string;
  readonly orderRef: string | null;
}

export class PlatformMailService extends Context.Tag("PlatformMailService")<
  PlatformMailService,
  {
    readonly sendApprovalLink: (
      input: SendApprovalLinkInput,
    ) => Effect.Effect<void, PlatformMailError>;
    readonly sendAccountDeleted: (
      input: SendAccountDeletedInput,
    ) => Effect.Effect<void, PlatformMailError>;
    /**
     * Operational alert to the tenant's operator when a conversation
     * connector goes dark (audit L5): a lapsed Graph subscription or a
     * revoked refresh token silently stops inbound customer mail —
     * someone must be told.
     */
    readonly sendConnectorAlert: (
      input: SendConnectorAlertInput,
    ) => Effect.Effect<void, PlatformMailError>;
    /**
     * Notify a supplier that a ticket was escalated to them, with a link to the
     * supplier portal. The durable outbox sweep (worker) calls this; the
     * escalation row's notified_at ledger drives retry, so a transient failure
     * here just means the next sweep pass re-sends.
     */
    readonly sendSupplierEscalation: (
      input: SendSupplierEscalationInput,
    ) => Effect.Effect<void, PlatformMailError>;
    /**
     * Email channel of a merchant heads-up (the `merchant.notify` tool +
     * runtime emitters). Recipient resolved from the tenant's
     * `notificationEmail` like the approval/connector mail; a tenant without
     * one surfaces `PlatformMailUnconfigured` and the multi-channel notifier
     * falls back to its other channels. The lightweight always-on counterpart
     * to the Telegram ping.
     */
    readonly sendMerchantNotification: (
      input: SendMerchantNotificationInput,
    ) => Effect.Effect<void, PlatformMailError>;
  }
>() {}

// ============================================================
// Test layer
// ============================================================

export type PlatformMailTestRecord =
  | { readonly kind: "approval-link"; readonly input: SendApprovalLinkInput }
  | {
      readonly kind: "account-deleted";
      readonly input: SendAccountDeletedInput;
    }
  | {
      readonly kind: "connector-alert";
      readonly input: SendConnectorAlertInput;
    }
  | {
      readonly kind: "supplier-escalation";
      readonly input: SendSupplierEscalationInput;
    }
  | {
      readonly kind: "merchant-notification";
      readonly input: SendMerchantNotificationInput;
    };

export interface PlatformMailTestHandle {
  readonly sent: ReadonlyArray<PlatformMailTestRecord>;
}

export interface PlatformMailTestFixtures {
  /** When true, every send fails with PlatformMailSendFailed. */
  readonly failAll?: boolean;
  /** When true, every send fails with PlatformMailUnconfigured. */
  readonly unconfiguredFor?: ReadonlySet<TenantId>;
}

export const makePlatformMailServiceTest = (
  fixtures: PlatformMailTestFixtures = {},
): {
  readonly layer: Layer.Layer<PlatformMailService>;
  readonly handle: PlatformMailTestHandle;
} => {
  const sent: Array<PlatformMailTestRecord> = [];
  const layer = Layer.succeed(
    PlatformMailService,
    PlatformMailService.of({
      sendApprovalLink: (input) =>
        Effect.suspend(
          (): Effect.Effect<void, PlatformMailError> => {
            if (fixtures.unconfiguredFor?.has(input.tenantId)) {
              return Effect.fail(
                new PlatformMailUnconfigured({ tenantId: input.tenantId }),
              );
            }
            if (fixtures.failAll) {
              return Effect.fail(
                new PlatformMailSendFailed({
                  tenantId: input.tenantId,
                  cause: "fixture: failAll",
                }),
              );
            }
            sent.push({ kind: "approval-link", input });
            return Effect.succeed(undefined);
          },
        ),
      sendAccountDeleted: (input) =>
        Effect.suspend(
          (): Effect.Effect<void, PlatformMailError> => {
            if (fixtures.unconfiguredFor?.has(input.tenantId)) {
              return Effect.fail(
                new PlatformMailUnconfigured({ tenantId: input.tenantId }),
              );
            }
            if (fixtures.failAll) {
              return Effect.fail(
                new PlatformMailSendFailed({
                  tenantId: input.tenantId,
                  cause: "fixture: failAll",
                }),
              );
            }
            sent.push({ kind: "account-deleted", input });
            return Effect.succeed(undefined);
          },
        ),
      sendConnectorAlert: (input) =>
        Effect.suspend(
          (): Effect.Effect<void, PlatformMailError> => {
            if (fixtures.unconfiguredFor?.has(input.tenantId)) {
              return Effect.fail(
                new PlatformMailUnconfigured({ tenantId: input.tenantId }),
              );
            }
            if (fixtures.failAll) {
              return Effect.fail(
                new PlatformMailSendFailed({
                  tenantId: input.tenantId,
                  cause: "fixture: failAll",
                }),
              );
            }
            sent.push({ kind: "connector-alert", input });
            return Effect.succeed(undefined);
          },
        ),
      sendSupplierEscalation: (input) =>
        Effect.suspend(
          (): Effect.Effect<void, PlatformMailError> => {
            if (fixtures.unconfiguredFor?.has(input.tenantId)) {
              return Effect.fail(
                new PlatformMailUnconfigured({ tenantId: input.tenantId }),
              );
            }
            if (fixtures.failAll) {
              return Effect.fail(
                new PlatformMailSendFailed({
                  tenantId: input.tenantId,
                  cause: "fixture: failAll",
                }),
              );
            }
            sent.push({ kind: "supplier-escalation", input });
            return Effect.succeed(undefined);
          },
        ),
      sendMerchantNotification: (input) =>
        Effect.suspend(
          (): Effect.Effect<void, PlatformMailError> => {
            if (fixtures.unconfiguredFor?.has(input.tenantId)) {
              return Effect.fail(
                new PlatformMailUnconfigured({ tenantId: input.tenantId }),
              );
            }
            if (fixtures.failAll) {
              return Effect.fail(
                new PlatformMailSendFailed({
                  tenantId: input.tenantId,
                  cause: "fixture: failAll",
                }),
              );
            }
            sent.push({ kind: "merchant-notification", input });
            return Effect.succeed(undefined);
          },
        ),
    }),
  );
  const handle: PlatformMailTestHandle = {
    get sent() {
      return sent;
    },
  };
  return { layer, handle };
};

/** Layer-only convenience: when the test doesn't need to inspect sends. */
export const PlatformMailServiceTest = (
  fixtures: PlatformMailTestFixtures = {},
): Layer.Layer<PlatformMailService> =>
  makePlatformMailServiceTest(fixtures).layer;
