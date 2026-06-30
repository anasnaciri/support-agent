import { Effect, Layer } from "effect";
import {
  NetworkError,
  TrackingProviderRateLimited,
  TrackingProviderUnavailable,
  type TenantId,
  type TrackingError,
  type TrackingLookup,
} from "@support-agent/agent-core";
import {
  TrackingConfig,
  TrackingService,
  publicTrackingUrl,
  type LookupTrackingInput,
} from "@support-agent/services";
import {
  SeventeenTrackHttpError,
  seventeenTrackGetInfo,
  seventeenTrackRegister,
} from "./seventeentrack-http.js";

// ============================================================
// Error mapping
// ============================================================

const mapHttpError = (
  err: unknown,
  ctx: { trackingNumber: string },
): TrackingError => {
  if (err instanceof SeventeenTrackHttpError) {
    const f = err.failure;
    if (f.kind === "rate_limited") {
      return new TrackingProviderRateLimited({ retryAfterMs: f.retryAfterMs });
    }
    // Auth + 4xx invalid + network all collapse to a single
    // "unavailable" branch from the tool's perspective — they're
    // platform-side problems the operator can't fix at the case level.
    return new TrackingProviderUnavailable({
      trackingNumber: ctx.trackingNumber,
      message: err.message,
    });
  }
  return new NetworkError({ cause: err });
};

// ============================================================
// Live Layer
// ============================================================

/**
 * Live `TrackingService` over 17track. Reads the platform's shared
 * `TrackingConfig` (built once at worker bootstrap from
 * `SEVENTEENTRACK_API_KEY`), pre-registers the tracking number with
 * 17track, then fetches the status.
 *
 * Failure handling is designed to keep agent flows resilient:
 *   - Auth/network/upstream-500: maps to `TrackingError` so the tool
 *     boundary surfaces it as `ToolOutputInvalid`. The agent's prompt
 *     handles that as a "skip tracking enrichment, drop straight to
 *     the reply with the public URL" path.
 *   - 17track `rejected[]` (unsupported carrier / bad number): NOT an
 *     error — maps to `kind: "no_provider"` with reason
 *     `unsupported_carrier` so the agent reply still has a URL.
 *
 * The register call is wrapped in `Effect.either` so a register
 * failure doesn't abort the gettrackinfo flow (17track's register is
 * idempotent and is sometimes flaky for already-registered numbers).
 */
export const TrackingServiceLive: Layer.Layer<
  TrackingService,
  never,
  TrackingConfig
> = Layer.effect(
  TrackingService,
  Effect.gen(function* () {
    const cfg = yield* TrackingConfig;

    const lookup = (
      _tenantId: TenantId,
      input: LookupTrackingInput,
    ): Effect.Effect<TrackingLookup, TrackingError> =>
      Effect.gen(function* () {
        // Register: best-effort. Already-registered numbers return
        // success too; we tolerate any failure here and fall through
        // to gettrackinfo. If the number is genuinely invalid,
        // gettrackinfo's `rejected[]` will catch it.
        yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              seventeenTrackRegister({
                apiKey: cfg.apiKey,
                trackingNumber: input.trackingNumber,
                carrier: input.carrier ?? null,
                ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
              }),
            catch: () => undefined,
          }),
        );

        const info = yield* Effect.tryPromise({
          try: () =>
            seventeenTrackGetInfo({
              apiKey: cfg.apiKey,
              trackingNumber: input.trackingNumber,
              ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
            }),
          catch: (cause) =>
            mapHttpError(cause, { trackingNumber: input.trackingNumber }),
        });

        if (info === null) {
          // 17track rejected the number (unsupported carrier / bad
          // format). Surface as `no_provider` so the agent can still
          // hand the customer a public URL.
          return {
            kind: "no_provider",
            carrier: input.carrier ?? "unknown",
            trackingNumber: input.trackingNumber,
            trackingUrl: publicTrackingUrl(input.trackingNumber),
            reason: "unsupported_carrier",
          } as const;
        }

        return {
          kind: "live",
          carrier: info.carrier,
          trackingNumber: input.trackingNumber,
          status: info.status,
          lastScan: info.lastScan,
          estimatedDeliveryAt: info.estimatedDeliveryAt,
          trackingUrl: publicTrackingUrl(input.trackingNumber),
          originCountry: info.originCountry,
          destinationCountry: info.destinationCountry,
          transitDays: info.transitDays,
          checkpoints: info.checkpoints,
        } as const;
      });

    return TrackingService.of({ lookup });
  }),
);
