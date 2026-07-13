import { Effect, Schema } from "effect";
import {
  defineTool,
  ToolOutputInvalid,
  type TicketStatus,
} from "@support-agent/agent-core";
import { TicketLifecycleWriter } from "@support-agent/services";

const StatusLiteral = Schema.Literal(
  "new",
  "triaging",
  "in_progress",
  "waiting_for_customer",
  "waiting_for_fulfillment_operator",
  "waiting_for_approval",
  "approved_action_running",
  "resolved",
  "failed",
  "human_takeover",
);

const Input = Schema.Struct({
  status: StatusLiteral,
  reason: Schema.optional(Schema.String),
  expectedFromStatus: Schema.optional(StatusLiteral),
});

const Output = Schema.Struct({
  ticketId: Schema.String,
  status: StatusLiteral,
});

export const ticketUpdateStatus = defineTool({
  name: "ticket.update_status",
  description:
    "Transition the current ticket to a new status. Status changes are auditable and follow the ticket state machine. Optionally pass `expectedFromStatus` for an optimistic check.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "write",
  defaultPermission: "allow",
  sideEffectClass: "external_state",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const lifecycle = yield* TicketLifecycleWriter;
      const opts: {
        reason?: string;
        expectedFromStatus?: TicketStatus;
      } = {};
      if (input.reason !== undefined) opts.reason = input.reason;
      if (input.expectedFromStatus !== undefined)
        opts.expectedFromStatus = input.expectedFromStatus;

      const updated = yield* lifecycle
        .applyAgentStatusUpdate({
          ticketId: ctx.ticketId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          toStatus: input.status,
          tool: "ticket.update_status",
          callId: ctx.callId,
          ...opts,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "ticket.update_status",
                issues: [e._tag],
              }),
          ),
        );

      return { ticketId: updated.id, status: input.status };
    }),
});
