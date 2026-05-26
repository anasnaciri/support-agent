import { Context, Effect, Layer } from "effect";
import type {
  TenantId,
  TrackingError,
  TrackingLookup,
} from "@support-agent/agent-core";

// ============================================================
// Tag
// ============================================================

/**
 * Carrier shipment lookup. Read-only, on-demand: an agent with a
 * tracking number in scope yields this Tag and gets back a normalised
 * `TrackingLookup` discriminated union. See `TrackingLookup` in
 * `agent-core/payloads.ts` for the result shape.
 *
 * `carrier` is a soft hint — the Live impl (17track) auto-detects from
 * the number if omitted. Pass it through from Shopify's
 * `fulfillment.trackingCompany` when available to make 17track's
 * detection deterministic.
 *
 * The Tag is provider-neutral. Today only 17track is wired up; future
 * Aftership / EasyPost Live impls implement the same surface.
 */
export interface LookupTrackingInput {
  readonly trackingNumber: string;
  readonly carrier?: string | null;
}

export class TrackingService extends Context.Tag("TrackingService")<
  TrackingService,
  {
    readonly lookup: (
      tenantId: TenantId,
      input: LookupTrackingInput,
    ) => Effect.Effect<TrackingLookup, TrackingError>;
  }
>() {}

// ============================================================
// Public-URL helper (used by NoProvider + as a default for Live)
// ============================================================

/**
 * Construct 17track's public web lookup URL. The page at
 * `https://t.17track.net/en#nums=<encoded>` accepts a bare tracking
 * number and detects the carrier client-side, so this works without
 * any API key. Used by `TrackingServiceNoProvider` and by the Live
 * impl as a fallback when the upstream response carries no carrier
 * deep link.
 */
export const publicTrackingUrl = (trackingNumber: string): string =>
  `https://t.17track.net/en#nums=${encodeURIComponent(trackingNumber)}`;

// ============================================================
// Test layer — fixture-driven, deterministic
// ============================================================

export interface TrackingTestFixtures {
  /**
   * Per-(trackingNumber) override. When the input matches an entry,
   * the Test layer returns that fixture verbatim. Tests use this to
   * pin specific carrier-side state (e.g. `delivered`) for an agent
   * flow under test.
   */
  readonly lookupByNumber?: ReadonlyMap<string, TrackingLookup>;
  /**
   * Full override of the `lookup` impl. When set, all fixture
   * behaviour above is bypassed and every call routes through this
   * function — useful for tests asserting error paths.
   */
  readonly lookup?: (
    tenantId: TenantId,
    input: LookupTrackingInput,
  ) => Effect.Effect<TrackingLookup, TrackingError>;
}

/**
 * In-memory `TrackingService` for unit tests. Default behaviour:
 * returns `kind: "live"` with a synthetic in-transit status so a tool
 * test doesn't have to seed fixtures just to exercise the happy path.
 * Override per-tracking-number via `lookupByNumber`, or replace the
 * whole impl via `lookup`.
 */
export const TrackingServiceTest = (
  fixtures: TrackingTestFixtures = {},
): Layer.Layer<TrackingService> =>
  Layer.succeed(
    TrackingService,
    TrackingService.of({
      lookup: (tenantId, input) => {
        if (fixtures.lookup) {
          return fixtures.lookup(tenantId, input);
        }
        const hit = fixtures.lookupByNumber?.get(input.trackingNumber);
        if (hit) {
          return Effect.succeed(hit);
        }
        // Deterministic happy path so a tool that calls `tracking.lookup`
        // and doesn't care about the exact carrier state can run.
        return Effect.succeed({
          kind: "live",
          carrier: input.carrier ?? "UPS",
          trackingNumber: input.trackingNumber,
          status: "in_transit",
          lastScan: {
            occurredAt: new Date("2026-05-23T12:00:00.000Z"),
            location: "TEST",
            description: "In transit (test fixture)",
          },
          estimatedDeliveryAt: new Date("2026-05-26T00:00:00.000Z"),
          trackingUrl: publicTrackingUrl(input.trackingNumber),
        });
      },
    }),
  );
