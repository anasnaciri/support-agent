import { Effect, Schema } from "effect";
import {
  defineTool,
  ToolOutputInvalid,
  type CaseStatus,
} from "@support-agent/agent-core";
import { CaseLifecycleWriter } from "@support-agent/services";

const StatusLiteral = Schema.Literal(
  "new",
  "triaging",
  "in_progress",
  "waiting_for_customer",
  "waiting_for_supplier",
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
  caseId: Schema.String,
  status: StatusLiteral,
});

export const caseUpdateStatus = defineTool({
  name: "case.update_status",
  description:
    "Transition the current case to a new status. Status changes are auditable and follow the case state machine. Optionally pass `expectedFromStatus` for an optimistic check.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "write",
  defaultPermission: "allow",
  sideEffectClass: "external_state",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const lifecycle = yield* CaseLifecycleWriter;
      const opts: {
        reason?: string;
        expectedFromStatus?: CaseStatus;
      } = {};
      if (input.reason !== undefined) opts.reason = input.reason;
      if (input.expectedFromStatus !== undefined)
        opts.expectedFromStatus = input.expectedFromStatus;

      const updated = yield* lifecycle
        .applyAgentStatusUpdate({
          caseId: ctx.caseId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          toStatus: input.status,
          tool: "case.update_status",
          callId: ctx.callId,
          ...opts,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "case.update_status",
                issues: [e._tag],
              }),
          ),
        );

      return { caseId: updated.id, status: input.status };
    }),
});
