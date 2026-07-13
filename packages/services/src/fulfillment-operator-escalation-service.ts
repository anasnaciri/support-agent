import { Context, Data, Effect, Layer } from "effect";
import type { TicketId, TenantId } from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

/**
 * The escalation row couldn't be written (DB failure). This is a TRANSIENT,
 * retryable error — distinct from "no fulfillmentOperator configured", which is a normal
 * `no_fulfillment_operator` RESULT (below) the agent should NOT retry.
 */
export class FulfillmentOperatorEscalationWriteFailed extends Data.TaggedError(
  "FulfillmentOperatorEscalationWriteFailed",
)<{
  readonly cause: unknown;
}> {}

export type FulfillmentOperatorEscalationError = FulfillmentOperatorEscalationWriteFailed;

// ============================================================
// Tag
// ============================================================

export interface EscalateInput {
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  /** The agent's rewritten, customer-PII-free problem statement. */
  readonly problem: string;
  readonly orderRef: string | null;
  readonly shipCity: string | null;
  readonly shipCountry: string | null;
  readonly trackingNumber: string | null;
  /** Runtime-selected images from the customer message being resolved. */
  readonly requestAttachmentIds: ReadonlyArray<string>;
}

/**
 * Outcome of an escalate attempt.
 *
 * - `escalated` — a fulfillmentOperator was found and the escalation row was written; the
 *   runtime parks the ticket in `waiting_for_fulfillment_operator`.
 * - `no_fulfillment_operator` — the workspace has NO fulfillmentOperator configured. This is a normal
 *   result, NOT an error: the agent must not retry it and should fall back to a
 *   direct customer reply (and the fulfillmentOperator sheet, if connected). Only a genuine
 *   DB write failure fails the Effect (so the agent retries that).
 */
export type EscalateResult =
  | {
      readonly kind: "escalated";
      readonly escalationId: string;
      readonly fulfillmentOperatorId: string;
      /** For the notification sweep (§10) to address the fulfillmentOperator email. */
      readonly fulfillmentOperatorEmail: string;
    }
  | { readonly kind: "no_fulfillment_operator" };

/**
 * Records a fulfillmentOperator escalation for a ticket. The agent calls this via the
 * `fulfillment_operator.escalate` tool; the runtime then parks the ticket in
 * `waiting_for_fulfillment_operator` ONLY when the result is `escalated`. The Live impl
 * resolves the workspace's default fulfillmentOperator and inserts the
 * `ticket_fulfillment_operator_escalations` row (with the privacy projection).
 *
 * Tag in `services`, Live in `db` (the dependency rule: agent-core/tools never
 * import db; the runtime's outer Layer provides the Live impl).
 */
export class FulfillmentOperatorEscalationService extends Context.Tag(
  "FulfillmentOperatorEscalationService",
)<
  FulfillmentOperatorEscalationService,
  {
    readonly escalate: (
      input: EscalateInput,
    ) => Effect.Effect<EscalateResult, FulfillmentOperatorEscalationError>;
    /**
     * Whether the ticket still has an OPEN escalation — the row-derived source
     * of truth for "waiting on a fulfillmentOperator" under concurrent wait states (the
     * ticket status may show the primary wait, e.g. `waiting_for_approval`).
     * The runtime consults this before resolving on an approval resume.
     */
    readonly hasOpenEscalationForTicket: (
      tenantId: TenantId,
      ticketId: TicketId,
    ) => Effect.Effect<boolean, FulfillmentOperatorEscalationError>;
  }
>() {}

// ============================================================
// Test layer — in-memory, deterministic
// ============================================================

export interface FulfillmentOperatorEscalationTestFixtures {
  /** Full replacement for `escalate` — use to capture the input in a test. */
  readonly escalate?: (
    input: EscalateInput,
  ) => Effect.Effect<EscalateResult, FulfillmentOperatorEscalationError>;
  /** Return the `no_fulfillment_operator` result (the workspace has no fulfillmentOperator). */
  readonly noFulfillmentOperator?: boolean;
  /** Fail with a transient write error (to exercise the agent's retry path). */
  readonly writeFailed?: boolean;
  /** Override the synthesized `escalated` result fields. */
  readonly result?: Partial<Extract<EscalateResult, { kind: "escalated" }>>;
  /**
   * Ticket ids `hasOpenEscalationForTicket` reports as still-open. Defaults to
   * none (false for every ticket).
   */
  readonly openEscalationTicketIds?: ReadonlyArray<string>;
}

export const FulfillmentOperatorEscalationServiceTest = (
  fixtures: FulfillmentOperatorEscalationTestFixtures = {},
) =>
  Layer.succeed(
    FulfillmentOperatorEscalationService,
    FulfillmentOperatorEscalationService.of({
      escalate: (input) => {
        if (fixtures.escalate) return fixtures.escalate(input);
        if (fixtures.noFulfillmentOperator) {
          return Effect.succeed({ kind: "no_fulfillment_operator" as const });
        }
        if (fixtures.writeFailed) {
          return Effect.fail(
            new FulfillmentOperatorEscalationWriteFailed({ cause: "fixture: writeFailed" }),
          );
        }
        return Effect.succeed({
          kind: "escalated" as const,
          escalationId: fixtures.result?.escalationId ?? "esc-test",
          fulfillmentOperatorId: fixtures.result?.fulfillmentOperatorId ?? "sup-test",
          fulfillmentOperatorEmail:
            fixtures.result?.fulfillmentOperatorEmail ??
            "fulfillment-operator@example.com",
        });
      },
      hasOpenEscalationForTicket: (_tenantId, ticketId) =>
        Effect.succeed(
          (fixtures.openEscalationTicketIds ?? []).includes(ticketId as string),
        ),
    }),
  );
