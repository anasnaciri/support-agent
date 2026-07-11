import { Clock, Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { TrackingService } from "@support-agent/services";

const Input = Schema.Struct({
  trackingNumber: Schema.String,
  // Optional hint. When present (typically from Shopify's
  // `fulfillment.trackingCompany`), the Live impl forwards it to
  // 17track to make carrier auto-detection deterministic. When null
  // or omitted, 17track detects from the number alone.
  carrier: Schema.optional(Schema.NullOr(Schema.String)),
});

const ScanEvent = Schema.Struct({
  occurredAt: Schema.String, // ISO 8601
  location: Schema.NullOr(Schema.String),
  description: Schema.String,
});

const Output = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("live"),
    carrier: Schema.String,
    trackingNumber: Schema.String,
    status: Schema.Literal(
      "in_transit",
      "delivered",
      "exception",
      "pending",
      "unknown",
    ),
    lastScan: Schema.NullOr(ScanEvent),
    estimatedDeliveryAt: Schema.NullOr(Schema.String),
    trackingUrl: Schema.String,
    // The carrier's own recipient country for this shipment (from 17track's
    // `recipient_address.country`), or null when the carrier doesn't report it.
    // An agent compares this against the order's `shippingAddress.country` to
    // catch a tracking number that belongs to a different order / destination
    // than the one the ticket is about. Country-granular only — 17track rarely
    // exposes street-level recipient detail — so a match is "same country",
    // not "same address".
    destinationCountry: Schema.NullOr(Schema.String),
    // Two scalars that let an agent judge "late" / "stuck" without doing date
    // arithmetic and without a current-date header. `transitDays` is the
    // provider's own count for the whole journey; `daysSinceLastScan` is
    // derived here from `lastScan.occurredAt` and says whether the parcel is
    // still moving. A long transit that scanned yesterday is slow; a long
    // transit whose last scan is weeks old is stuck. Both null when unknown.
    transitDays: Schema.NullOr(Schema.Number),
    daysSinceLastScan: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("no_provider"),
    carrier: Schema.String,
    trackingNumber: Schema.String,
    trackingUrl: Schema.String,
    reason: Schema.Literal("no_api_key", "unsupported_carrier", "sync_pending"),
  }),
);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days elapsed between a scan and now, floored. Clamped at 0 so a
 * future-dated checkpoint (carrier clock skew is common on international
 * handoffs) reads as "scanned just now" rather than a negative number the
 * model would have to interpret.
 */
const daysSince = (occurredAtMs: number, nowMs: number): number =>
  Math.max(0, Math.floor((nowMs - occurredAtMs) / DAY_MS));

export const trackingLookup = defineTool({
  name: "tracking.lookup",
  description:
    "Look up the live carrier status for a shipment by tracking number. Returns a discriminated union: `kind: \"live\"` when an upstream tracking provider is configured (status / last scan / ETA / tracking URL), OR `kind: \"no_provider\"` when no provider is wired up, the carrier isn't supported, or the upstream has not synced the newly registered number yet (still returns the tracking number + a public tracking URL the customer can follow). A `live` result also carries `transitDays` (whole days the shipment has been in transit, per the carrier) and `daysSinceLastScan` (whole days since the most recent checkpoint), use these to judge whether a shipment is late or stuck instead of computing dates yourself; either may be null when unknown. It also carries `destinationCountry`, the carrier's own recipient country for the shipment (country-granular, null when the carrier doesn't report it), which you can compare against the order's `shippingAddress.country` to confirm the tracking number belongs to this order's destination. Use this after `shopify.get_order` when a fulfillment carries a tracking number; pass the carrier hint from `fulfillment.trackingCompany` to make detection deterministic. The tool NEVER fails for missing-provider, agents branch on `kind` in their reply prompt.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const tracking = yield* TrackingService;
      const result = yield* tracking
        .lookup(ctx.tenantId, {
          trackingNumber: input.trackingNumber,
          carrier: input.carrier ?? null,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "tracking.lookup",
                issues: [e._tag],
              }),
          ),
        );
      // Map Date → ISO string at the boundary so the LLM sees stable
      // JSON. Other shape unchanged.
      if (result.kind === "live") {
        const nowMs = yield* Clock.currentTimeMillis;
        return {
          kind: "live" as const,
          carrier: result.carrier,
          trackingNumber: result.trackingNumber,
          status: result.status,
          lastScan: result.lastScan
            ? {
                occurredAt: result.lastScan.occurredAt.toISOString(),
                location: result.lastScan.location,
                description: result.lastScan.description,
              }
            : null,
          estimatedDeliveryAt:
            result.estimatedDeliveryAt?.toISOString() ?? null,
          trackingUrl: result.trackingUrl,
          destinationCountry: result.destinationCountry ?? null,
          transitDays: result.transitDays ?? null,
          daysSinceLastScan: result.lastScan
            ? daysSince(result.lastScan.occurredAt.getTime(), nowMs)
            : null,
        };
      }
      return {
        kind: "no_provider" as const,
        carrier: result.carrier,
        trackingNumber: result.trackingNumber,
        trackingUrl: result.trackingUrl,
        reason: result.reason,
      };
    }),
});
