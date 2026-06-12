import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";

const Input = Schema.Struct({});

const Location = Schema.Struct({
  name: Schema.String,
  instructions: Schema.NullOr(Schema.String),
  address1: Schema.NullOr(Schema.String),
  address2: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  province: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
  zip: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
});

const Output = Schema.Struct({
  locations: Schema.Array(Location),
});

export const shopifyListPickupLocations = defineTool({
  name: "shopify.list_pickup_locations",
  description:
    "List the store's customer pickup points — only locations where local pickup is enabled, with their address and any merchant pickup instructions. Use this to answer 'can I pick up my order?' or 'do you have a store I can visit?'. An empty list means the store offers no customer pickup. These are pickup points ONLY: they say nothing about where orders ship from, and the store's warehouses or fulfillment locations are never included or revealed.",
  inputSchema: Input,
  outputSchema: Output,
  // Read-only, always allowed, internal plumbing (no tenantControl /
  // displayName — hidden from the per-agent Actions UI). The underlying
  // service filters to pickup-enabled locations, so no caller of this
  // tool can ever see a private warehouse or dropship origin.
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: ["read_locations"],
  },
  execute: (_input, ctx) =>
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;
      const locations = yield* shopify.listPickupLocations(ctx.tenantId).pipe(
        Effect.mapError(
          (e) =>
            new ToolOutputInvalid({
              tool: "shopify.list_pickup_locations",
              issues: [e._tag],
            }),
        ),
      );
      return {
        locations: locations.map((l) => ({
          name: l.name,
          instructions: l.instructions,
          address1: l.address1,
          address2: l.address2,
          city: l.city,
          province: l.province,
          country: l.country,
          zip: l.zip,
          phone: l.phone,
        })),
      };
    }),
});
