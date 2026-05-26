import { Effect, Schema } from "effect";
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
  }),
  Schema.Struct({
    kind: Schema.Literal("no_provider"),
    carrier: Schema.String,
    trackingNumber: Schema.String,
    trackingUrl: Schema.String,
    reason: Schema.Literal("no_api_key", "unsupported_carrier"),
  }),
);

export const trackingLookup = defineTool({
  name: "tracking.lookup",
  description:
    "Look up the live carrier status for a shipment by tracking number. Returns a discriminated union: `kind: \"live\"` when an upstream tracking provider is configured (status / last scan / ETA / tracking URL), OR `kind: \"no_provider\"` when no provider is wired up or the carrier isn't supported (still returns the tracking number + a public tracking URL the customer can follow). Use this after `shopify.get_order` when a fulfillment carries a tracking number; pass the carrier hint from `fulfillment.trackingCompany` to make detection deterministic. The tool NEVER fails for missing-provider — agents branch on `kind` in their reply prompt.",
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
