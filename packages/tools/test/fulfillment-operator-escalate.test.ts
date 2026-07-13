import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  TicketId,
  TenantId,
  ToolOutputInvalid,
  type ToolContext,
} from "@support-agent/agent-core";
import {
  FulfillmentOperatorEscalationServiceTest,
  type EscalateInput,
} from "@support-agent/services";
import { fulfillmentOperatorEscalate } from "../src/index.js";

const tenantId = TenantId("t1");
const baseCtx = (ticketId: string): ToolContext => ({
  tenantId,
  ticketId: TicketId(ticketId),
  agentId: AgentId("missing-package-agent"),
  callId: "call_1",
  attemptNumber: 1,
});

describe("fulfillment_operator.escalate tool", () => {
  it("forwards the privacy projection (+ tenant/ticket from ctx) and returns the escalation id", async () => {
    let captured: EscalateInput | undefined;
    const env = FulfillmentOperatorEscalationServiceTest({
      escalate: (input) => {
        captured = input;
        return Effect.succeed({
          kind: "escalated" as const,
          escalationId: "esc-9",
          fulfillmentOperatorId: "sup-9",
          fulfillmentOperatorEmail: "wh@x.com",
        });
      },
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        fulfillmentOperatorEscalate.execute(
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
    expect(result["escalated"]).toBe(true);
    expect(result["escalationId"]).toBe("esc-9");
    expect(result["fulfillmentOperatorId"]).toBe("sup-9");
    expect(captured).toMatchObject({
      tenantId: "t1",
      ticketId: "c-1",
      problem: "Order stuck 12 days past the delivery window",
      orderRef: "#1001",
      shipCity: "Berlin",
      shipCountry: "DE",
      trackingNumber: "TRK1",
    });
  });

  it("defaults missing projection fields to null", async () => {
    let captured: EscalateInput | undefined;
    const env = FulfillmentOperatorEscalationServiceTest({
      escalate: (input) => {
        captured = input;
        return Effect.succeed({
          kind: "escalated" as const,
          escalationId: "e",
          fulfillmentOperatorId: "s",
          fulfillmentOperatorEmail: "w@x.com",
        });
      },
    });
    await Effect.runPromise(
      Effect.provide(
        fulfillmentOperatorEscalate.execute(
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

  it("returns escalated:false (no error) when the workspace has no fulfillmentOperator — the agent falls back, never retries", async () => {
    const env = FulfillmentOperatorEscalationServiceTest({ noFulfillmentOperator: true });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        fulfillmentOperatorEscalate.execute(
          { problem: "P" } as never,
          baseCtx("c-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["escalated"]).toBe(false);
    expect(result["reason"]).toBe("no_fulfillment_operator");
    expect(result["escalationId"]).toBeUndefined();
  });

  it("maps a transient write failure to ToolOutputInvalid (so the agent retries)", async () => {
    const env = FulfillmentOperatorEscalationServiceTest({ writeFailed: true });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        fulfillmentOperatorEscalate.execute(
          { problem: "P" } as never,
          baseCtx("c-4"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("fulfillment_operator.escalate");
        expect(err.issues).toEqual(["FulfillmentOperatorEscalationWriteFailed"]);
      }
    }
  });

  it("declares its risk/permission surface and a stable idempotency key", () => {
    expect(fulfillmentOperatorEscalate.name).toBe("fulfillment_operator.escalate");
    expect(fulfillmentOperatorEscalate.defaultPermission).toBe("ask");
    expect(fulfillmentOperatorEscalate.sideEffectClass).toBe("external_state");
    expect(fulfillmentOperatorEscalate.tenantControl).toBe("permission-toggle");
    expect(
      fulfillmentOperatorEscalate.idempotencyKey!({
        problem: "P",
        orderRef: "#1001",
      } as never),
    ).toBe("fulfillment-operator-escalate:#1001");
    // Falls back to the problem prefix when there's no order ref.
    expect(
      fulfillmentOperatorEscalate.idempotencyKey!({ problem: "a".repeat(50) } as never),
    ).toBe(`fulfillment-operator-escalate:${"a".repeat(40)}`);
  });
});
