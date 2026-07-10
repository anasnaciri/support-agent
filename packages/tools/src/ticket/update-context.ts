import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { TicketRepository } from "@support-agent/services";

/**
 * Context patch — a FIXED set of named fields, shallow-merged into the ticket's
 * `context`. There is deliberately no free-form `extra` / open record: the
 * context blob is re-injected into the model verbatim on `ticket.resumed`, so an
 * open schema would let a prompt-injected tool call plant arbitrary keys that
 * resurface as text the agent reads on its next turn. New derived facts get a
 * named field here, not an escape hatch. The runtime decodes every call
 * against this schema (audit L10), which drops any unknown keys.
 */
const Input = Schema.Struct({
  classification: Schema.optional(Schema.String),
  /**
   * The customer's QUOTED order reference, verbatim — an order name (`#1001`)
   * or a confirmation code (`XPAV284CT`). This is an UNTRUSTED hint that drives
   * the specialist's first `shopify.get_order` lookup; it is deliberately NOT
   * the canonical `identifiedOrderId`. That field holds the stable Shopify GID
   * and is stamped by the runtime only after an order tool actually resolves the
   * order — agents cannot write it, so a mistyped/forged code can never
   * masquerade as a verified order binding (the single source of truth).
   */
  quotedOrderRef: Schema.optional(Schema.String),
  identifiedCustomerId: Schema.optional(Schema.String),
  /**
   * The customer's phone number, when the message states one that the
   * deterministic ingest parser (`inboundCustomerPhone`) didn't capture — an
   * unusual format or label the regex missed. A benign contact detail (used
   * only as a fallback identifier for the customer lookup, email → phone →
   * name — never an identity/permission gate), so unlike `customerEmail` it's
   * safe for the agent to write; `ShopifyService.searchByPhone` normalizes it
   * before querying.
   */
  customerPhone: Schema.optional(Schema.String),
  /**
   * The resolution scenario triage matched this ticket to (a `ScenarioPolicy.key`
   * — built-in like `delivery_issue` or a merchant-defined custom key). The
   * scenario-resolution agent reads it to load the scenario's tool/permission
   * envelope + playbook. A free string (the key set is merchant-extensible), but
   * still a single NAMED field in the closed schema — never an open map — so an
   * injection can only write this one key, not a runtime-reserved one.
   */
  scenarioKey: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  /**
   * Outcome of the damaged-product photo-vs-product cross-check:
   * `match` (the photos depict the ordered item), `mismatch` (they
   * don't appear to), or `uncertain` (can't tell). Surfaced on the
   * approval card so the operator's confidence is calibrated before
   * they approve the reply.
   */
  productMatch: Schema.optional(
    Schema.Literal("match", "mismatch", "uncertain"),
  ),
  /**
   * Why the customer wants to return/refund — captured by refund-review-agent
   * when the message is a return. Narrow literal union (not free text) so the
   * dashboard maps it to a chip, it re-orients the agent on resume as a stable
   * fact, and an injection can't stuff arbitrary prose into the key.
   */
  returnReason: Schema.optional(
    Schema.Literal(
      "defective",
      "wrong_item",
      "no_longer_needed",
      "arrived_late",
      "other",
    ),
  ),
  /**
   * What the customer is asking for as the outcome. Same rationale as
   * `returnReason` — a closed vocabulary, not free text. `refund` here is the
   * customer's stated wish; the actual money movement still goes through
   * `refund.create`'s permission gate.
   */
  requestedResolution: Schema.optional(
    Schema.Literal(
      "refund",
      "replacement",
      "exchange",
      "store_credit",
      "repair",
    ),
  ),
  /**
   * Carrier-side shipment state — the `tracking.lookup` result, stamped by
   * order-status-agent so a takeover operator sees live tracking on the ticket.
   *
   * A single named field with an EXPLICIT shape — deliberately not an open
   * `Record`/`extra` map. That keeps two properties: an injection can only
   * write this one key (never a runtime-reserved key like `customerEmail` /
   * `riskFlags`), AND unknown sub-keys are dropped at decode, so the value
   * re-injected on resume (inside the untrusted fence) is a known shape, not
   * attacker-chosen text. It's a tolerant projection of the tracking union
   * (cross-arm fields optional so one struct validates either `live` /
   * `no_provider` arm) rather than a reuse of the tool's strict union, so a
   * lossy model copy degrades a field instead of dropping the whole stamp.
   */
  liveTrackingStatus: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal("live", "no_provider"),
      status: Schema.optional(
        Schema.Literal(
          "in_transit",
          "delivered",
          "exception",
          "pending",
          "unknown",
        ),
      ),
      carrier: Schema.optional(Schema.NullOr(Schema.String)),
      trackingNumber: Schema.optional(Schema.String),
      lastScan: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            occurredAt: Schema.String,
            location: Schema.NullOr(Schema.String),
            description: Schema.String,
          }),
        ),
      ),
      estimatedDeliveryAt: Schema.optional(Schema.NullOr(Schema.String)),
      trackingUrl: Schema.optional(Schema.String),
      // Mirrors the two lateness scalars on a `tracking.lookup` live result, so
      // a takeover operator sees the numbers the agent judged on.
      transitDays: Schema.optional(Schema.NullOr(Schema.Number)),
      daysSinceLastScan: Schema.optional(Schema.NullOr(Schema.Number)),
      // Mirrors the carrier's recipient country, so an operator sees the
      // destination the agent compared against the order's shipping country.
      destinationCountry: Schema.optional(Schema.NullOr(Schema.String)),
      reason: Schema.optional(
        Schema.Literal("no_api_key", "unsupported_carrier", "sync_pending"),
      ),
    }),
  ),
});

const Output = Schema.Struct({
  ticketId: Schema.String,
  contextKeys: Schema.Array(Schema.String),
});

export const ticketUpdateContext = defineTool({
  name: "ticket.update_context",
  description:
    "Shallow-merge fields into the ticket's `context` JSON. Use this to record classification, identified IDs, customer-facing notes, a customer phone number the message states (if not already captured), and any other derived facts.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "write",
  defaultPermission: "allow",
  sideEffectClass: "external_state",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const repo = yield* TicketRepository;

      const current = yield* repo.getById(ctx.ticketId).pipe(
        Effect.mapError(
          (e) =>
            new ToolOutputInvalid({
              tool: "ticket.update_context",
              issues: [e._tag],
            }),
        ),
      );

      const patch: Record<string, unknown> = { ...current.context };
      if (input.classification !== undefined)
        patch["classification"] = input.classification;
      if (input.quotedOrderRef !== undefined)
        patch["quotedOrderRef"] = input.quotedOrderRef;
      if (input.identifiedCustomerId !== undefined)
        patch["identifiedCustomerId"] = input.identifiedCustomerId;
      if (input.customerPhone !== undefined)
        patch["customerPhone"] = input.customerPhone;
      if (input.scenarioKey !== undefined)
        patch["scenarioKey"] = input.scenarioKey;
      if (input.notes !== undefined) patch["notes"] = input.notes;
      if (input.productMatch !== undefined)
        patch["productMatch"] = input.productMatch;
      if (input.returnReason !== undefined)
        patch["returnReason"] = input.returnReason;
      if (input.requestedResolution !== undefined)
        patch["requestedResolution"] = input.requestedResolution;
      if (input.liveTrackingStatus !== undefined)
        patch["liveTrackingStatus"] = input.liveTrackingStatus;

      // The dashboard's category chip and the tickets-list search filter read
      // the `category` column, not the context blob — mirror the
      // classification there so triage output is visible outside the agent.
      const updated = yield* repo
        .update(ctx.ticketId, {
          context: patch,
          ...(input.classification !== undefined
            ? { category: input.classification }
            : {}),
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "ticket.update_context",
                issues: [e._tag],
              }),
          ),
        );

      return {
        ticketId: updated.id,
        contextKeys: Object.keys(updated.context),
      };
    }),
});
