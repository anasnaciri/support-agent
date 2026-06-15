import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { SupplierEscalationService } from "@support-agent/services";

// The agent supplies the privacy projection itself (from its prior
// shopify.get_order), so the supplier query never has to join back to the case
// or customer tables. `problem` MUST be a rewritten, customer-PII-free summary.
const Input = Schema.Struct({
  problem: Schema.String,
  orderRef: Schema.optional(Schema.NullOr(Schema.String)),
  shipCity: Schema.optional(Schema.NullOr(Schema.String)),
  shipCountry: Schema.optional(Schema.NullOr(Schema.String)),
  trackingNumber: Schema.optional(Schema.NullOr(Schema.String)),
});

const Output = Schema.Struct({
  escalationId: Schema.String,
  supplierId: Schema.String,
});

export const supplierEscalate = defineTool({
  name: "supplier.escalate",
  description:
    "Escalate this case to the warehouse / supplier when you cannot resolve it yourself and need them to act (chase the carrier, reship, confirm a delay) — e.g. an order is past its delivery window and stuck in transit. Calling this PARKS the case for the supplier: you are done for this turn and must NOT send a customer reply now. When the supplier responds you will be re-engaged to draft the customer reply. `problem` must be a concise, rewritten statement of what you need the supplier to do — NEVER include the customer's email, full address, or message text. Include `orderRef`, `shipCity`, `shipCountry`, and `trackingNumber` from the order so the warehouse can act. Permission policy: defaultPermission is `ask`; a merchant may set this agent to `auto` to let escalations through without approval.",
  displayName: "Escalate to supplier",
  displayDescription:
    "The agent hands a case it can't resolve to your warehouse/supplier and waits for their update before replying to the customer.",
  tenantControl: "permission-toggle",
  inputSchema: Input,
  outputSchema: Output,
  // An internal state change (records the escalation + parks the case) that also
  // triggers an out-of-band supplier notification — closest to a write with an
  // external side effect, not a customer-facing message and not financial.
  risk: "write",
  defaultPermission: "ask",
  sideEffectClass: "external_state",
  // Bind retries of the same escalation together so a runtime replay doesn't
  // create a second escalation row (the runtime consults this for
  // sideEffectClass !== "none"). Order ref is the stable key; fall back to the
  // problem prefix when the order couldn't be identified.
  idempotencyKey: (input) =>
    `supplier-escalate:${input.orderRef ?? input.problem.slice(0, 40)}`,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const svc = yield* SupplierEscalationService;
      const result = yield* svc
        .escalate({
          tenantId: ctx.tenantId,
          caseId: ctx.caseId,
          problem: input.problem,
          orderRef: input.orderRef ?? null,
          shipCity: input.shipCity ?? null,
          shipCountry: input.shipCountry ?? null,
          trackingNumber: input.trackingNumber ?? null,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "supplier.escalate",
                issues: [e._tag],
              }),
          ),
        );
      return { escalationId: result.escalationId, supplierId: result.supplierId };
    }),
});
