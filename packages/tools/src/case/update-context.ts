import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { CaseRepository } from "@support-agent/services";

/**
 * Free-form context patch. The named fields below are hints to the LLM about
 * the keys the runtime knows how to consume; arbitrary extra keys are
 * preserved too. The patch is shallow-merged into the case's `context`.
 */
const Input = Schema.Struct({
  classification: Schema.optional(Schema.String),
  identifiedOrderId: Schema.optional(Schema.String),
  identifiedCustomerId: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  extra: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});

const Output = Schema.Struct({
  caseId: Schema.String,
  contextKeys: Schema.Array(Schema.String),
});

export const caseUpdateContext = defineTool({
  name: "case.update_context",
  description:
    "Shallow-merge fields into the case's `context` JSON. Use this to record classification, identified IDs, customer-facing notes, and any other derived facts.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "write",
  defaultPermission: "allow",
  sideEffectClass: "external_state",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const repo = yield* CaseRepository;

      const current = yield* repo.getById(ctx.caseId).pipe(
        Effect.mapError(
          (e) =>
            new ToolOutputInvalid({
              tool: "case.update_context",
              issues: [e._tag],
            }),
        ),
      );

      const patch: Record<string, unknown> = { ...current.context };
      if (input.classification !== undefined)
        patch["classification"] = input.classification;
      if (input.identifiedOrderId !== undefined)
        patch["identifiedOrderId"] = input.identifiedOrderId;
      if (input.identifiedCustomerId !== undefined)
        patch["identifiedCustomerId"] = input.identifiedCustomerId;
      if (input.notes !== undefined) patch["notes"] = input.notes;
      if (input.extra !== undefined) Object.assign(patch, input.extra);

      const updated = yield* repo
        .update(ctx.caseId, { context: patch })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "case.update_context",
                issues: [e._tag],
              }),
          ),
        );

      return {
        caseId: updated.id,
        contextKeys: Object.keys(updated.context),
      };
    }),
});
