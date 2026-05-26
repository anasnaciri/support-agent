import { Effect, Layer } from "effect";
import {
  TrackingService,
  publicTrackingUrl,
} from "./tracking-service.js";

/**
 * `TrackingService` layer used when the platform has no upstream
 * tracking provider configured (e.g. `SEVENTEENTRACK_API_KEY` unset).
 * Every call resolves with `kind: "no_provider"` so agents fall back
 * to the public tracking URL in their customer reply instead of
 * crashing on a missing service.
 *
 * The worker bootstrap swaps in `TrackingServiceLive` when the env var
 * is present; this layer is the safe default the rest of the test
 * suite + local dev workflows depend on.
 */
export const TrackingServiceNoProvider: Layer.Layer<TrackingService> =
  Layer.succeed(
    TrackingService,
    TrackingService.of({
      lookup: (_tenantId, input) =>
        Effect.succeed({
          kind: "no_provider",
          carrier: input.carrier ?? "unknown",
          trackingNumber: input.trackingNumber,
          trackingUrl: publicTrackingUrl(input.trackingNumber),
          reason: "no_api_key",
        }),
    }),
  );
