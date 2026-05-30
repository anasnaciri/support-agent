import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";

const Input = Schema.Struct({
  productId: Schema.String,
});

const ProductImage = Schema.Struct({
  url: Schema.String,
  altText: Schema.NullOr(Schema.String),
});

const Output = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  productType: Schema.NullOr(Schema.String),
  vendor: Schema.NullOr(Schema.String),
  images: Schema.Array(ProductImage),
});

export const shopifyGetProduct = defineTool({
  name: "shopify.get_product",
  description:
    "Look up a Shopify product by its `gid://shopify/Product/...` GID (or bare numeric id). Returns the product's title, type, vendor, and reference image URLs. Use this to cross-check a customer's photo evidence against the product they actually ordered: pass the `productId` from an order line item, then compare the returned `images` against the customer's photos to judge whether they depict the same item.",
  inputSchema: Input,
  outputSchema: Output,
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
      const product = yield* shopify
        .getProduct(ctx.tenantId, input.productId)
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "shopify.get_product",
                issues: [e._tag],
              }),
          ),
        );
      return {
        id: product.id,
        title: product.title,
        productType: product.productType,
        vendor: product.vendor,
        images: product.images.map((img) => ({
          url: img.url,
          altText: img.altText,
        })),
      };
    }),
});
