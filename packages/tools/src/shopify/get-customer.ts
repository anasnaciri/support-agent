import { Effect, Schema } from "effect";
import {
  CustomerId,
  defineTool,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";

const Input = Schema.Struct({
  customerId: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});

const Money = Schema.Struct({
  amount: Schema.String,
  currencyCode: Schema.String,
});

const Address = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  address1: Schema.NullOr(Schema.String),
  address2: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  province: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
  zip: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
});

const Output = Schema.Struct({
  id: Schema.String,
  email: Schema.NullOr(Schema.String),
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  ordersCount: Schema.Number,
  totalSpent: Money,
  defaultAddress: Schema.NullOr(Address),
  createdAt: Schema.String,
});

export const shopifyGetCustomer = defineTool({
  name: "shopify.get_customer",
  description:
    "Look up a Shopify customer by id (preferred) or by email. Provide EXACTLY ONE of `customerId` or `email` — not both, not neither. Returns customer name, contact info, orders count, total spent, and default address. Use this when you need to identify or enrich a customer's profile beyond what's already on the ticket.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: ["read_customers"],
  },
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const hasId =
        input.customerId !== undefined && input.customerId.length > 0;
      const hasEmail = input.email !== undefined && input.email.length > 0;
      if (hasId === hasEmail) {
        return yield* Effect.fail(
          new ToolOutputInvalid({
            tool: "shopify.get_customer",
            issues: ["exactly_one_of_customerId_email"],
          }),
        );
      }

      const shopify = yield* ShopifyService;
      const customer = hasId
        ? yield* shopify
            .getCustomer(ctx.tenantId, CustomerId(input.customerId!))
            .pipe(
              Effect.mapError(
                (e) =>
                  new ToolOutputInvalid({
                    tool: "shopify.get_customer",
                    issues: [e._tag],
                  }),
              ),
            )
        : yield* shopify
            .searchByEmail(ctx.tenantId, input.email!)
            .pipe(
              Effect.mapError(
                (e) =>
                  new ToolOutputInvalid({
                    tool: "shopify.get_customer",
                    issues: [e._tag],
                  }),
              ),
              // searchByEmail returns `null` (not a typed error) when no
              // match — map it to the same ToolOutputInvalid shape as a
              // by-id miss so the LLM sees one consistent failure mode.
              Effect.flatMap((c) =>
                c
                  ? Effect.succeed(c)
                  : Effect.fail(
                      new ToolOutputInvalid({
                        tool: "shopify.get_customer",
                        issues: ["CustomerNotFound"],
                      }),
                    ),
              ),
            );

      return {
        id: customer.id,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        ordersCount: customer.ordersCount,
        totalSpent: customer.totalSpent,
        defaultAddress: customer.defaultAddress
          ? {
              name: customer.defaultAddress.name,
              address1: customer.defaultAddress.address1,
              address2: customer.defaultAddress.address2,
              city: customer.defaultAddress.city,
              province: customer.defaultAddress.province,
              country: customer.defaultAddress.country,
              zip: customer.defaultAddress.zip,
              phone: customer.defaultAddress.phone,
            }
          : null,
        createdAt: customer.createdAt.toISOString(),
      };
    }),
});
