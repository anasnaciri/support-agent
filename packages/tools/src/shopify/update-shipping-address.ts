import { Effect, Option, Schema } from "effect";
import {
  OrderId,
  defineTool,
  ToolOutputInvalid,
  ToolPreconditionFailed,
  type ShopifyAddress,
} from "@support-agent/agent-core";
import { ShopifyService, TenantRepository } from "@support-agent/services";

// Each address field is three-state, mirroring the dashboard's Ship-to pencil
// (ticket-shipping-address.ts): absent = keep the order's current value,
// null = clear it, a string = replace it. Shopify's `orderUpdate` replaces
// the WHOLE shipping address, so the tool merges the edit over the order's
// current address before the write — a customer correcting their ZIP doesn't
// wipe the street.
const EditableField = Schema.optional(Schema.NullOr(Schema.String));

const Input = Schema.Struct({
  // Same id shapes `order.cancel` accepts: a Shopify GID or numeric internal
  // id. By the time you're editing the address, the agent has already fetched
  // the order and has the GID in scope; order names like `#1001` are NOT
  // accepted.
  orderId: Schema.String,
  name: EditableField,
  address1: EditableField,
  address2: EditableField,
  city: EditableField,
  province: EditableField,
  country: EditableField,
  zip: EditableField,
  phone: EditableField,
});

const AddressOutput = Schema.Struct({
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
  orderId: Schema.String,
  // The full shipping address as Shopify stored (normalized) it.
  address: AddressOutput,
});

const EMPTY_ADDRESS: ShopifyAddress = {
  name: null,
  address1: null,
  address2: null,
  city: null,
  province: null,
  country: null,
  zip: null,
  phone: null,
};

const ADDRESS_FIELDS = [
  "name",
  "address1",
  "address2",
  "city",
  "province",
  "country",
  "zip",
  "phone",
] as const;

export const shopifyUpdateShippingAddress = defineTool({
  name: "order.update_shipping_address",
  description:
    "Change the shipping address on a Shopify order that has NOT shipped yet. The tool refuses an order with any fulfillment (`OrderAlreadyFulfilled`) or a cancelled order (`OrderCancelled`), once a parcel is on its way the destination cannot be changed here; follow the scenario guidance instead (e.g. escalate to the fulfillment operator). Exception: when the store has declared it can update a shipping address after fulfillment (see the store facts), the fulfilled-order refusal does not apply. The `orderId` must be a Shopify GID (`gid://shopify/Order/...`); order names like `#1001` are NOT accepted, call `shopify.get_order` first. Address fields are per-field edits merged over the order's current address: omit a field to keep its current value, pass null to clear it, pass a string to replace it (so correcting the street never wipes the city). Only pass values the CUSTOMER explicitly gave, never invent or autocomplete parts of an address; if the customer has not provided the complete new address, ask them for it with `conversation.ask_customer` before calling this. Returns the full address as the store saved it. This redirects where a real parcel will be delivered: never call it twice for the same request, if the result is unclear, re-check via `shopify.get_order` instead of retrying.",
  displayDescription:
    "The agent corrects the shipping address on an order that hasn't shipped yet, when the customer asks.",
  tenantControl: "permission-toggle",
  inputSchema: Input,
  outputSchema: Output,
  risk: "write",
  defaultPermission: "ask",
  sideEffectClass: "external_state",
  // Shopify gates `orderUpdate` behind `write_orders` — the same scope
  // refunds and cancellations already require, so no new scope is requested.
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: ["write_orders"],
  },
  // Bind retries together: a stable key over the order lets the runtime's
  // execution-marker dedup catch LLM re-emissions and redeliveries.
  idempotencyKey: (input) => `ship:${input.orderId}`,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      // Guard refusals are ToolPreconditionFailed: deterministic, pre-write,
      // side-effect-free. The runtime hands them back to the agent as an
      // observation (redraft, tell the customer) instead of parking the
      // ticket the way an unexpected failure (ToolOutputInvalid) does.
      const refuse = (issue: string) =>
        Effect.fail(
          new ToolPreconditionFailed({
            tool: "order.update_shipping_address",
            issue,
          }),
        );

      if (ADDRESS_FIELDS.every((f) => input[f] === undefined)) {
        return yield* refuse("NothingToUpdate");
      }

      const shopify = yield* ShopifyService;

      // Pre-write read: the merge base AND the consequence guard. An order
      // with any fulfillment already has a parcel moving to the OLD address —
      // editing the order wouldn't redirect it, only mislead the customer.
      const order = yield* shopify
        .getOrder(ctx.tenantId, OrderId(input.orderId))
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "order.update_shipping_address",
                issues: [e._tag],
              }),
          ),
        );
      if (order.cancelledAt) return yield* refuse("OrderCancelled");
      if (order.fulfillments.length > 0) {
        // Merchant-declared capability (Facts page): the store can update a
        // shipping address after fulfillment, stated literally. Optional
        // service + fail-safe read: no repository in context or a failed
        // settings read means the capability is absent and the guard holds.
        const tenantRepo = yield* Effect.serviceOption(TenantRepository);
        const allowAfterFulfillment = Option.isSome(tenantRepo)
          ? yield* tenantRepo.value.getSettings(ctx.tenantId).pipe(
              Effect.map(
                (s) => s.addressUpdateAfterFulfillment === true,
              ),
              Effect.catchAll(() => Effect.succeed(false)),
            )
          : false;
        if (!allowAfterFulfillment) {
          return yield* refuse("OrderAlreadyFulfilled");
        }
      }

      const base = order.shippingAddress ?? EMPTY_ADDRESS;
      const merged: ShopifyAddress = {
        name: input.name === undefined ? base.name : input.name,
        address1: input.address1 === undefined ? base.address1 : input.address1,
        address2: input.address2 === undefined ? base.address2 : input.address2,
        city: input.city === undefined ? base.city : input.city,
        province: input.province === undefined ? base.province : input.province,
        country: input.country === undefined ? base.country : input.country,
        zip: input.zip === undefined ? base.zip : input.zip,
        phone: input.phone === undefined ? base.phone : input.phone,
      };

      const stored = yield* shopify
        .updateOrderShippingAddress(ctx.tenantId, {
          orderId: order.id,
          address: merged,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "order.update_shipping_address",
                issues: [e._tag],
              }),
          ),
        );

      return {
        orderId: order.id,
        address: {
          name: stored.name,
          address1: stored.address1,
          address2: stored.address2,
          city: stored.city,
          province: stored.province,
          country: stored.country,
          zip: stored.zip,
          phone: stored.phone,
        },
      };
    }),
});
