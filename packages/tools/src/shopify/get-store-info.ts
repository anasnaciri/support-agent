import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";

const Input = Schema.Struct({});

const Output = Schema.Struct({
  name: Schema.String,
  contactEmail: Schema.NullOr(Schema.String),
  domain: Schema.String,
  currencyCode: Schema.String,
  shipsWorldwide: Schema.Boolean,
  shipsToCountries: Schema.NullOr(Schema.Array(Schema.String)),
});

/**
 * A "Rest of world" shipping zone makes Shopify return every country
 * code (~240). Above this threshold the list collapses to
 * `shipsWorldwide: true` with NO list — dropping it entirely, because a
 * truncated list would read as "only these countries" and produce wrong
 * ship-to answers. Real per-country lists (the common curated ticket) sit
 * far below this.
 */
const SHIPS_WORLDWIDE_THRESHOLD = 100;

export const shopifyGetStoreInfo = defineTool({
  name: "shopify.get_store_info",
  description:
    "Read the store's public facts: store name, public website (`domain`), customer-facing contact email (null when the store hasn't set one), default currency, and where the store ships TO — either `shipsWorldwide: true` or the explicit `shipsToCountries` ISO country-code list. Use this to answer 'do you ship to X?', 'where do you ship?', 'how do I contact you?', or 'what's your website?'. It says nothing about shipping costs, delivery times (answer those from the knowledge base), or where orders ship FROM (never reveal that).",
  inputSchema: Input,
  outputSchema: Output,
  // Read-only public store facts, always allowed. Internal plumbing like
  // `shopify.search_products` — no `tenantControl`/`displayName`, so it
  // stays out of the per-agent Actions UI. The empty scopes array still
  // requires an ACTIVE Shopify connection (PermissionService checks the
  // connection exists even when no specific scope is listed).
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: [],
  },
  execute: (_input, ctx) =>
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;
      const info = yield* shopify.getShopInfo(ctx.tenantId).pipe(
        Effect.mapError(
          (e) =>
            new ToolOutputInvalid({
              tool: "shopify.get_store_info",
              issues: [e._tag],
            }),
        ),
      );
      const worldwide =
        info.shipsToCountries.length >= SHIPS_WORLDWIDE_THRESHOLD;
      return {
        name: info.name,
        contactEmail: info.contactEmail,
        domain: info.primaryDomainUrl,
        currencyCode: info.currencyCode,
        shipsWorldwide: worldwide,
        shipsToCountries: worldwide ? null : [...info.shipsToCountries],
      };
    }),
});
