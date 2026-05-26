import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  TrackingService,
  TrackingServiceNoProvider,
  TrackingServiceTest,
  publicTrackingUrl,
} from "../src/index.js";

const tenantId = TenantId("t1");

describe("TrackingServiceTest", () => {
  it("returns a deterministic live status when no fixture matches", async () => {
    const layer = TrackingServiceTest({});
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "1Z999", carrier: "UPS" }),
        ),
        layer,
      ),
    );
    expect(result.kind).toBe("live");
    if (result.kind === "live") {
      expect(result.trackingNumber).toBe("1Z999");
      expect(result.carrier).toBe("UPS");
      expect(result.status).toBe("in_transit");
      expect(result.trackingUrl).toContain("1Z999");
    }
  });

  it("returns the per-number fixture when one matches", async () => {
    const layer = TrackingServiceTest({
      lookupByNumber: new Map([
        [
          "1Z888",
          {
            kind: "live",
            carrier: "FedEx",
            trackingNumber: "1Z888",
            status: "delivered",
            lastScan: null,
            estimatedDeliveryAt: null,
            trackingUrl: "https://example.com/1Z888",
          },
        ],
      ]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "1Z888" }),
        ),
        layer,
      ),
    );
    expect(result.kind).toBe("live");
    if (result.kind === "live") {
      expect(result.carrier).toBe("FedEx");
      expect(result.status).toBe("delivered");
    }
  });

  it("routes through the full-impl override when provided", async () => {
    const calls: string[] = [];
    const layer = TrackingServiceTest({
      lookup: (_t, input) => {
        calls.push(input.trackingNumber);
        return Effect.succeed({
          kind: "no_provider",
          carrier: "unknown",
          trackingNumber: input.trackingNumber,
          trackingUrl: publicTrackingUrl(input.trackingNumber),
          reason: "unsupported_carrier",
        });
      },
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "EXOTIC-1" }),
        ),
        layer,
      ),
    );
    expect(result.kind).toBe("no_provider");
    expect(calls).toEqual(["EXOTIC-1"]);
  });
});

describe("TrackingServiceNoProvider", () => {
  it("always returns kind: 'no_provider' with the 17track public URL", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TrackingService, (s) =>
          s.lookup(tenantId, { trackingNumber: "1Z777", carrier: "UPS" }),
        ),
        TrackingServiceNoProvider,
      ),
    );
    expect(result.kind).toBe("no_provider");
    if (result.kind === "no_provider") {
      expect(result.trackingNumber).toBe("1Z777");
      expect(result.carrier).toBe("UPS");
      expect(result.reason).toBe("no_api_key");
      expect(result.trackingUrl).toBe("https://t.17track.net/en#nums=1Z777");
    }
  });

  it("URL-encodes odd characters in the tracking number", () => {
    expect(publicTrackingUrl("AB CD?#")).toBe(
      "https://t.17track.net/en#nums=AB%20CD%3F%23",
    );
  });
});
