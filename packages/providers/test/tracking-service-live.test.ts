import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  TenantId,
  TrackingProviderRateLimited,
  TrackingProviderUnavailable,
} from "@support-agent/agent-core";
import { TrackingConfig, TrackingService } from "@support-agent/services";
import { TrackingServiceLive } from "../src/tracking-service-live.js";

const tenantId = TenantId("t1");

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const fail = (status: number, body = "", headers?: Headers): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    headers: headers ?? new Headers(),
  }) as unknown as Response;

const buildLayer = (fetchImpl: typeof fetch) =>
  TrackingServiceLive.pipe(
    Layer.provide(
      Layer.succeed(TrackingConfig, { apiKey: "k1", fetchImpl }),
    ),
  );

describe("TrackingServiceLive", () => {
  it("happy path: register + gettrackinfo → kind: 'live'", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) return okJson({});
      return okJson({
        code: 0,
        data: {
          accepted: [
            {
              number: "1Z999",
              carrier: 100002,
              track: { e: 30 },
              track_info: {
                latest_event: {
                  time_iso: "2026-05-23T12:00:00.000Z",
                  location: "Brooklyn, NY",
                  description: "On the truck",
                },
                estimated_delivery_date: { to: "2026-05-25" },
              },
            },
          ],
        },
      });
    });

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "1Z999", carrier: "UPS" }),
        ),
        buildLayer(fetchImpl as unknown as typeof fetch),
      ),
    );
    expect(result.kind).toBe("live");
    if (result.kind === "live") {
      expect(result.status).toBe("in_transit");
      expect(result.carrier).toBe("100002");
      expect(result.lastScan?.location).toBe("Brooklyn, NY");
      expect(result.trackingUrl).toContain("1Z999");
    }
    // Verify two calls: register, then gettrackinfo.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("registers without a carrier hint when input omits it", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) {
        const body = JSON.parse(String(init?.body ?? "[]"));
        expect(body[0]).not.toHaveProperty("carrier");
        return okJson({});
      }
      return okJson({
        code: 0,
        data: {
          accepted: [
            {
              number: "1Z999",
              carrier: 100002,
              track: { e: 40 },
            },
          ],
        },
      });
    });
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "1Z999" }),
        ),
        buildLayer(fetchImpl as unknown as typeof fetch),
      ),
    );
  });

  it("17track rejection → kind: 'no_provider' with reason 'unsupported_carrier'", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) return okJson({});
      return okJson({
        code: 0,
        data: {
          accepted: [],
          rejected: [{ number: "EXOTIC-1", error: { code: -1, message: "??" } }],
        },
      });
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "EXOTIC-1" }),
        ),
        buildLayer(fetchImpl as unknown as typeof fetch),
      ),
    );
    expect(result.kind).toBe("no_provider");
    if (result.kind === "no_provider") {
      expect(result.reason).toBe("unsupported_carrier");
      expect(result.trackingUrl).toContain("EXOTIC-1");
    }
  });

  it("17track sync-pending response fails instead of stamping unsupported_carrier", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) return okJson({});
      return okJson({
        code: 0,
        data: {
          accepted: [],
          rejected: [],
        },
      });
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "LULU1000630903" }),
        ),
        buildLayer(fetchImpl as unknown as typeof fetch),
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(TrackingProviderUnavailable);
    expect(exit.cause.error).toMatchObject({
      trackingNumber: "LULU1000630903",
      message: expect.stringContaining("sync pending"),
    });
  });

  it("upstream 429 → TrackingProviderRateLimited", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) return okJson({});
      return fail(429, "", new Headers({ "retry-after": "5" }));
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "1Z999" }),
        ),
        buildLayer(fetchImpl as unknown as typeof fetch),
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(TrackingProviderRateLimited);
  });

  it("upstream 401/network errors → TrackingProviderUnavailable", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) return okJson({});
      return fail(401, "auth");
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "1Z999" }),
        ),
        buildLayer(fetchImpl as unknown as typeof fetch),
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(TrackingProviderUnavailable);
  });

  it("register failure is tolerated — gettrackinfo still runs", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) {
        return fail(429, "", new Headers({ "retry-after": "1" }));
      }
      return okJson({
        code: 0,
        data: {
          accepted: [
            { number: "1Z999", carrier: 100002, track: { e: 40 } },
          ],
        },
      });
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "1Z999" }),
        ),
        buildLayer(fetchImpl as unknown as typeof fetch),
      ),
    );
    expect(result.kind).toBe("live");
    if (result.kind === "live") expect(result.status).toBe("delivered");
  });
});
