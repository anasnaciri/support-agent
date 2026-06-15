import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  TenantId,
  ToolOutputInvalid,
  type ToolContext,
} from "@support-agent/agent-core";
import {
  SupplierEscalationServiceTest,
  type EscalateInput,
} from "@support-agent/services";
import { supplierEscalate } from "../src/index.js";

const tenantId = TenantId("t1");
const baseCtx = (caseId: string): ToolContext => ({
  tenantId,
  caseId: CaseId(caseId),
  agentId: AgentId("missing-package-agent"),
  callId: "call_1",
  attemptNumber: 1,
});

describe("supplier.escalate tool", () => {
  it("forwards the privacy projection (+ tenant/case from ctx) and returns the escalation id", async () => {
    let captured: EscalateInput | undefined;
    const env = SupplierEscalationServiceTest({
      escalate: (input) => {
        captured = input;
        return Effect.succeed({
          escalationId: "esc-9",
          supplierId: "sup-9",
          supplierEmail: "wh@x.com",
        });
      },
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        supplierEscalate.execute(
          {
            problem: "Order stuck 12 days past the delivery window",
            orderRef: "#1001",
            shipCity: "Berlin",
            shipCountry: "DE",
            trackingNumber: "TRK1",
          } as never,
          baseCtx("c-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["escalationId"]).toBe("esc-9");
    expect(result["supplierId"]).toBe("sup-9");
    expect(captured).toMatchObject({
      tenantId: "t1",
      caseId: "c-1",
      problem: "Order stuck 12 days past the delivery window",
      orderRef: "#1001",
      shipCity: "Berlin",
      shipCountry: "DE",
      trackingNumber: "TRK1",
    });
  });

  it("defaults missing projection fields to null", async () => {
    let captured: EscalateInput | undefined;
    const env = SupplierEscalationServiceTest({
      escalate: (input) => {
        captured = input;
        return Effect.succeed({
          escalationId: "e",
          supplierId: "s",
          supplierEmail: "w@x.com",
        });
      },
    });
    await Effect.runPromise(
      Effect.provide(
        supplierEscalate.execute(
          { problem: "P" } as never,
          baseCtx("c-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(captured?.orderRef).toBeNull();
    expect(captured?.shipCity).toBeNull();
    expect(captured?.shipCountry).toBeNull();
    expect(captured?.trackingNumber).toBeNull();
  });

  it("maps SupplierNotConfigured to ToolOutputInvalid with the tag in issues", async () => {
    const env = SupplierEscalationServiceTest({ notConfigured: true });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        supplierEscalate.execute(
          { problem: "P" } as never,
          baseCtx("c-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("supplier.escalate");
        expect(err.issues).toEqual(["SupplierNotConfigured"]);
      }
    }
  });

  it("declares its risk/permission surface and a stable idempotency key", () => {
    expect(supplierEscalate.name).toBe("supplier.escalate");
    expect(supplierEscalate.defaultPermission).toBe("ask");
    expect(supplierEscalate.sideEffectClass).toBe("external_state");
    expect(supplierEscalate.tenantControl).toBe("permission-toggle");
    expect(
      supplierEscalate.idempotencyKey!({
        problem: "P",
        orderRef: "#1001",
      } as never),
    ).toBe("supplier-escalate:#1001");
    // Falls back to the problem prefix when there's no order ref.
    expect(
      supplierEscalate.idempotencyKey!({ problem: "a".repeat(50) } as never),
    ).toBe(`supplier-escalate:${"a".repeat(40)}`);
  });
});
