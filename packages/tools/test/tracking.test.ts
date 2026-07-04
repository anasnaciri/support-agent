import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  TicketId,
  NetworkError,
  TenantId,
  ToolOutputInvalid,
  type ToolContext,
  type TrackingError,
} from "@support-agent/agent-core";
import { TrackingServiceTest } from "@support-agent/services";
import { trackingLookup } from "../src/index.js";

const tenantId = TenantId("t1");
const baseCtx = (ticketId: string): ToolContext => ({
  tenantId,
  ticketId: TicketId(ticketId),
  agentId: AgentId("order-status-agent"),
  callId: "call_1",
  attemptNumber: 1,
});

describe("tracking.lookup tool", () => {
  it("returns the discriminated union with ISO dates on live results", async () => {
    const env = TrackingServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        trackingLookup.execute(
          {
            trackingNumber: "1Z999",
            carrier: "UPS",
          } as never,
          baseCtx("c-track-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["kind"]).toBe("live");
    expect(result["trackingNumber"]).toBe("1Z999");
    // ISO date strings, not Date instances
    expect(typeof result["estimatedDeliveryAt"]).toBe("string");
    const last = result["lastScan"] as Record<string, unknown> | null;
    expect(typeof last?.["occurredAt"]).toBe("string");
  });

  it("passes through no_provider results verbatim", async () => {
    const env = TrackingServiceTest({
      lookup: (_t, input) =>
        Effect.succeed({
          kind: "no_provider",
          carrier: "unknown",
          trackingNumber: input.trackingNumber,
          trackingUrl: `https://t.17track.net/en#nums=${input.trackingNumber}`,
          reason: "no_api_key",
        }),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        trackingLookup.execute(
          { trackingNumber: "1Z777" } as never,
          baseCtx("c-track-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["kind"]).toBe("no_provider");
    expect(result["reason"]).toBe("no_api_key");
    expect(String(result["trackingUrl"])).toContain("1Z777");
  });

  it("maps TrackingError to ToolOutputInvalid", async () => {
    const env = TrackingServiceTest({
      lookup: () =>
        Effect.fail(
          new NetworkError({ cause: "boom" }),
        ) as Effect.Effect<never, TrackingError>,
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        trackingLookup.execute(
          { trackingNumber: "1Z999" } as never,
          baseCtx("c-track-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("tracking.lookup");
        expect(err.issues).toEqual(["NetworkError"]);
      }
    }
  });

  it("declares the expected surface (read / allow / no scopes)", () => {
    expect(trackingLookup.name).toBe("tracking.lookup");
    expect(trackingLookup.risk).toBe("read");
    expect(trackingLookup.defaultPermission).toBe("allow");
    expect(trackingLookup.sideEffectClass).toBe("none");
    expect(trackingLookup.requiredConnectorScopes).toBeUndefined();
  });
});
