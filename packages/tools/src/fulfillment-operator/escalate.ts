import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { FulfillmentOperatorEscalationService } from "@support-agent/services";

// The agent supplies the privacy projection itself (from its prior
// shopify.get_order), so the fulfillment operator query never has to join back to the ticket
// or customer tables. `problem` MUST be a rewritten, customer-PII-free summary.
const Input = Schema.Struct({
  problem: Schema.String,
  orderRef: Schema.optional(Schema.NullOr(Schema.String)),
  shipCity: Schema.optional(Schema.NullOr(Schema.String)),
  shipCountry: Schema.optional(Schema.NullOr(Schema.String)),
  trackingNumber: Schema.optional(Schema.NullOr(Schema.String)),
  // Runtime-managed: the model's value is replaced with ids from the current
  // inbound customer message before permission gating or execution.
  requestAttachmentIds: Schema.optional(Schema.Array(Schema.String)),
});

// `escalated: true` → a fulfillment operator was found and the ticket is now parked for them.
// `escalated: false` (reason "no_fulfillment_operator") → the workspace has no fulfillment operator
// configured; the agent should NOT retry and should fall back to a direct reply.
const Output = Schema.Struct({
  escalated: Schema.Boolean,
  escalationId: Schema.optional(Schema.String),
  fulfillmentOperatorId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});

export const fulfillmentOperatorEscalate = defineTool({
  name: "fulfillment_operator.escalate",
  description:
    "Escalate this ticket to the Fulfillment Operator: the party responsible for picking, packing, shipping, and fixing delivery problems for this fulfillment. This may be the merchant's warehouse, a product supplier, a dropshipper, a 3PL, a print-on-demand service, or Amazon MCF. Use it when the operator needs to act (chase the carrier, reship, confirm a delay), e.g. an order is past its delivery window and stuck in transit. Returns `{ escalated: true }` when a fulfillment operator was found; the ticket is then PARKED for them, so you are done this turn and must NOT send a customer reply (you'll be re-engaged when they respond). Returns `{ escalated: false, reason: \"no_fulfillment_operator\" }` when the store has no fulfillment operator configured; do NOT retry and fall back to replying to the customer yourself. A thrown error is transient; retry once. `problem` must be a concise, rewritten statement of what you need the fulfillment operator to do. NEVER include the customer's email, full address, or message text. Include `orderRef`, `shipCity`, `shipCountry`, and `trackingNumber` from the order so the operator can act. Permission policy: defaultPermission is `ask`; a merchant may set this agent to `auto` to let escalations through without approval.",
  displayDescription:
    "The agent asks your fulfillment partner to act on a shipping or delivery problem and waits for their update before replying to the customer.",
  tenantControl: "permission-toggle",
  inputSchema: Input,
  outputSchema: Output,
  // An internal state change (records the escalation + parks the ticket) that also
  // triggers an out-of-band fulfillment operator notification — closest to a write with an
  // external side effect, not a customer-facing message and not financial.
  risk: "write",
  defaultPermission: "ask",
  sideEffectClass: "external_state",
  // Bind retries of the same escalation together so a runtime replay doesn't
  // create a second escalation row (the runtime consults this for
  // sideEffectClass !== "none"). Order ref is the stable key; fall back to the
  // problem prefix when the order couldn't be identified.
  idempotencyKey: (input) =>
    `fulfillment-operator-escalate:${input.orderRef ?? input.problem.slice(0, 40)}`,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const svc = yield* FulfillmentOperatorEscalationService;
      const result = yield* svc
        .escalate({
          tenantId: ctx.tenantId,
          ticketId: ctx.ticketId,
          problem: input.problem,
          orderRef: input.orderRef ?? null,
          shipCity: input.shipCity ?? null,
          shipCountry: input.shipCountry ?? null,
          trackingNumber: input.trackingNumber ?? null,
          requestAttachmentIds: input.requestAttachmentIds ?? [],
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "fulfillment_operator.escalate",
                issues: [e._tag],
              }),
          ),
        );
      // "no fulfillment operator" is a normal outcome the agent branches on (fall back to a
      // direct reply); only a genuine write failure surfaces as a tool error
      // (which the agent retries).
      if (result.kind === "no_fulfillment_operator") {
        return { escalated: false, reason: "no_fulfillment_operator" };
      }
      return {
        escalated: true,
        escalationId: result.escalationId,
        fulfillmentOperatorId: result.fulfillmentOperatorId,
      };
    }),
});
