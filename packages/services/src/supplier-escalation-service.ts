import { Context, Data, Effect, Layer } from "effect";
import type { CaseId, TenantId } from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

/**
 * The escalation row couldn't be written (DB failure). This is a TRANSIENT,
 * retryable error — distinct from "no supplier configured", which is a normal
 * `no_supplier` RESULT (below) the agent should NOT retry.
 */
export class SupplierEscalationWriteFailed extends Data.TaggedError(
  "SupplierEscalationWriteFailed",
)<{
  readonly cause: unknown;
}> {}

export type SupplierEscalationError = SupplierEscalationWriteFailed;

// ============================================================
// Tag
// ============================================================

export interface EscalateInput {
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  /** The agent's rewritten, customer-PII-free problem statement. */
  readonly problem: string;
  readonly orderRef: string | null;
  readonly shipCity: string | null;
  readonly shipCountry: string | null;
  readonly trackingNumber: string | null;
}

/**
 * Outcome of an escalate attempt.
 *
 * - `escalated` — a supplier was found and the escalation row was written; the
 *   runtime parks the case in `waiting_for_supplier`.
 * - `no_supplier` — the workspace has NO supplier configured. This is a normal
 *   result, NOT an error: the agent must not retry it and should fall back to a
 *   direct customer reply (and the supplier sheet, if connected). Only a genuine
 *   DB write failure fails the Effect (so the agent retries that).
 */
export type EscalateResult =
  | {
      readonly kind: "escalated";
      readonly escalationId: string;
      readonly supplierId: string;
      /** For the notification sweep (§10) to address the supplier email. */
      readonly supplierEmail: string;
    }
  | { readonly kind: "no_supplier" };

/**
 * Records a supplier escalation for a case. The agent calls this via the
 * `supplier.escalate` tool; the runtime then parks the case in
 * `waiting_for_supplier` ONLY when the result is `escalated`. The Live impl
 * resolves the workspace's default supplier and inserts the
 * `case_supplier_escalations` row (with the privacy projection).
 *
 * Tag in `services`, Live in `db` (the dependency rule: agent-core/tools never
 * import db; the runtime's outer Layer provides the Live impl).
 */
export class SupplierEscalationService extends Context.Tag(
  "SupplierEscalationService",
)<
  SupplierEscalationService,
  {
    readonly escalate: (
      input: EscalateInput,
    ) => Effect.Effect<EscalateResult, SupplierEscalationError>;
  }
>() {}

// ============================================================
// Test layer — in-memory, deterministic
// ============================================================

export interface SupplierEscalationTestFixtures {
  /** Full replacement for `escalate` — use to capture the input in a test. */
  readonly escalate?: (
    input: EscalateInput,
  ) => Effect.Effect<EscalateResult, SupplierEscalationError>;
  /** Return the `no_supplier` result (the workspace has no supplier). */
  readonly noSupplier?: boolean;
  /** Fail with a transient write error (to exercise the agent's retry path). */
  readonly writeFailed?: boolean;
  /** Override the synthesized `escalated` result fields. */
  readonly result?: Partial<Extract<EscalateResult, { kind: "escalated" }>>;
}

export const SupplierEscalationServiceTest = (
  fixtures: SupplierEscalationTestFixtures = {},
) =>
  Layer.succeed(
    SupplierEscalationService,
    SupplierEscalationService.of({
      escalate: (input) => {
        if (fixtures.escalate) return fixtures.escalate(input);
        if (fixtures.noSupplier) {
          return Effect.succeed({ kind: "no_supplier" as const });
        }
        if (fixtures.writeFailed) {
          return Effect.fail(
            new SupplierEscalationWriteFailed({ cause: "fixture: writeFailed" }),
          );
        }
        return Effect.succeed({
          kind: "escalated" as const,
          escalationId: fixtures.result?.escalationId ?? "esc-test",
          supplierId: fixtures.result?.supplierId ?? "sup-test",
          supplierEmail: fixtures.result?.supplierEmail ?? "supplier@example.com",
        });
      },
    }),
  );
