import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";

const Input = Schema.Struct({
  query: Schema.String,
});

const Money = Schema.Struct({
  amount: Schema.String,
  currencyCode: Schema.String,
});

const Option = Schema.Struct({
  name: Schema.String,
  values: Schema.Array(Schema.String),
});

const Variant = Schema.Struct({
  title: Schema.String,
  price: Money,
  availableForSale: Schema.Boolean,
});

const Product = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  productType: Schema.NullOr(Schema.String),
  vendor: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  priceMin: Money,
  priceMax: Money,
  availableForSale: Schema.Boolean,
  onlineStoreUrl: Schema.NullOr(Schema.String),
  options: Schema.Array(Option),
  variants: Schema.Array(Variant),
});

const Output = Schema.Struct({
  products: Schema.Array(Product),
});

// Keep the result set small: a handful of matches is plenty to answer
// "do you sell X?" and a wide list just burns prompt tokens.
const SEARCH_LIMIT = 5;

export const shopifySearchProducts = defineTool({
  name: "shopify.search_products",
  description:
    "Search the store's product catalog by keyword (matches product title, type, vendor, and tags). Pass the customer's product question or a few keywords as `query`; returns up to a handful of matching products with title, type, vendor, a short description, price range (in the store's currency), customer-facing availability (a boolean, never stock counts), option/variant breakdown, and the product's storefront URL (`onlineStoreUrl`, null when the product isn't published online, never invent a link in that case). Use this to answer 'do you sell X?', 'how much is Y?', 'is Z in stock?', or option questions grounded in the real catalog, never guess whether a product exists, what it costs, or whether it's available. Returns an empty list when nothing matches.",
  inputSchema: Input,
  outputSchema: Output,
  // Read-only catalog lookup, always allowed. Like `shopify.get_product`
  // and `knowledge.search` it carries no `tenantControl`/`displayName`,
  // so it's internal plumbing rather than a tenant-configurable outward
  // action and stays out of the per-agent "Actions" UI.
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: ["read_products"],
  },
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;
      const products = yield* shopify
        .searchProducts(ctx.tenantId, input.query, SEARCH_LIMIT)
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "shopify.search_products",
                issues: [e._tag],
              }),
          ),
        );
      return {
        products: products.map((p) => ({
          id: p.id,
          title: p.title,
          productType: p.productType,
          vendor: p.vendor,
          description: p.description,
          priceMin: p.priceMin,
          priceMax: p.priceMax,
          availableForSale: p.availableForSale,
          onlineStoreUrl: p.onlineStoreUrl,
          options: p.options.map((o) => ({
            name: o.name,
            values: o.values,
          })),
          variants: p.variants.map((v) => ({
            title: v.title,
            price: v.price,
            availableForSale: v.availableForSale,
          })),
        })),
      };
    }),
});
