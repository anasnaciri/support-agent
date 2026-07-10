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

  const DAY_MS = 24 * 60 * 60 * 1000;

  const liveFixture = (
    over: Partial<{
      lastScan: { occurredAt: Date; location: string | null; description: string } | null;
      transitDays: number | null;
      destinationCountry: string | null;
    }>,
  ) =>
    TrackingServiceTest({
      lookup: (_t, input) =>
        Effect.succeed({
          kind: "live",
          carrier: "UPS",
          trackingNumber: input.trackingNumber,
          status: "in_transit",
          lastScan:
            "lastScan" in over
              ? over.lastScan
              : {
                  occurredAt: new Date("2026-05-23T12:00:00.000Z"),
                  location: "TEST",
                  description: "In transit",
                },
          estimatedDeliveryAt: null,
          trackingUrl: `https://t.17track.net/en#nums=${input.trackingNumber}`,
          ...("transitDays" in over ? { transitDays: over.transitDays } : {}),
          ...("destinationCountry" in over
            ? { destinationCountry: over.destinationCountry }
            : {}),
        }),
    });

  const runLive = async (env: ReturnType<typeof liveFixture>) => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        trackingLookup.execute(
          { trackingNumber: "LULU1000630903", carrier: null } as never,
          baseCtx("c-track-days"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    return exit.value as Record<string, unknown>;
  };

  it("surfaces the provider's transitDays on live results", async () => {
    const result = await runLive(liveFixture({ transitDays: 44 }));
    expect(result["transitDays"]).toBe(44);
  });

  it("nulls transitDays when the provider omits it", async () => {
    const result = await runLive(liveFixture({}));
    expect(result["transitDays"]).toBeNull();
  });

  it("surfaces the provider's destinationCountry on live results", async () => {
    const result = await runLive(
      liveFixture({ destinationCountry: "Germany" }),
    );
    expect(result["destinationCountry"]).toBe("Germany");
  });

  it("nulls destinationCountry when the provider omits it", async () => {
    const result = await runLive(liveFixture({}));
    expect(result["destinationCountry"]).toBeNull();
  });

  it("derives daysSinceLastScan from the last scan's age", async () => {
    const result = await runLive(
      liveFixture({
        lastScan: {
          occurredAt: new Date(Date.now() - 19 * DAY_MS),
          location: "HUB",
          description: "Departed facility",
        },
      }),
    );
    expect(result["daysSinceLastScan"]).toBe(19);
  });

  it("nulls daysSinceLastScan when there is no last scan", async () => {
    const result = await runLive(liveFixture({ lastScan: null }));
    expect(result["daysSinceLastScan"]).toBeNull();
  });

  it("clamps daysSinceLastScan to 0 for a future-dated scan", async () => {
    const result = await runLive(
      liveFixture({
        lastScan: {
          occurredAt: new Date(Date.now() + 2 * DAY_MS),
          location: "HUB",
          description: "Clock skew",
        },
      }),
    );
    expect(result["daysSinceLastScan"]).toBe(0);
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
