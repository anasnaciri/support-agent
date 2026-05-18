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

export class PlatformMailService extends Context.Tag("PlatformMailService")<
  PlatformMailService,
  {
    readonly sendApprovalLink: (
      input: SendApprovalLinkInput,
    ) => Effect.Effect<void, PlatformMailError>;
  }
>() {}

// ============================================================
// Test layer
// ============================================================

export interface PlatformMailTestRecord {
  readonly kind: "approval-link";
  readonly input: SendApprovalLinkInput;
}

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
