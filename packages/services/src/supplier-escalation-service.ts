import { Context, Data, Effect, Layer } from "effect";
import type { CaseId, TenantId } from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

/** The workspace has no supplier configured, so there's nowhere to escalate. */
export class SupplierNotConfigured extends Data.TaggedError(
  "SupplierNotConfigured",
)<{
  readonly tenantId: string;
}> {}

/** The escalation row couldn't be written (DB failure). */
export class SupplierEscalationWriteFailed extends Data.TaggedError(
  "SupplierEscalationWriteFailed",
)<{
  readonly cause: unknown;
}> {}

export type SupplierEscalationError =
  | SupplierNotConfigured
  | SupplierEscalationWriteFailed;

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

export interface EscalateResult {
  readonly escalationId: string;
  readonly supplierId: string;
  /** For the notification sweep (§10) to address the supplier email. */
  readonly supplierEmail: string;
}

/**
 * Records a supplier escalation for a case. The agent calls this via the
 * `supplier.escalate` tool; the runtime then parks the case in
 * `waiting_for_supplier`. The Live impl resolves the workspace's default
 * supplier and inserts the `case_supplier_escalations` row (with the privacy
 * projection); the supplier-facing dashboard reads it via the plain db store.
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
  /** When true (and no override), `escalate` fails with SupplierNotConfigured. */
  readonly notConfigured?: boolean;
  /** Override the synthesized success result fields. */
  readonly result?: Partial<EscalateResult>;
}

export const SupplierEscalationServiceTest = (
  fixtures: SupplierEscalationTestFixtures = {},
) =>
  Layer.succeed(
    SupplierEscalationService,
    SupplierEscalationService.of({
      escalate: (input) => {
        if (fixtures.escalate) return fixtures.escalate(input);
        if (fixtures.notConfigured) {
          return Effect.fail(
            new SupplierNotConfigured({ tenantId: input.tenantId }),
          );
        }
        return Effect.succeed({
          escalationId: fixtures.result?.escalationId ?? "esc-test",
          supplierId: fixtures.result?.supplierId ?? "sup-test",
          supplierEmail: fixtures.result?.supplierEmail ?? "supplier@example.com",
        });
      },
    }),
  );
