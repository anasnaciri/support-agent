import { Effect, Schema } from "effect";
import {
  ThreadId,
  defineTool,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import { ConversationService } from "@support-agent/services";

const Participant = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  email: Schema.String,
});

const Input = Schema.Struct({
  threadId: Schema.String,
  to: Schema.Array(Participant),
  subject: Schema.NullOr(Schema.String),
  bodyText: Schema.String,
  bodyHtml: Schema.NullOr(Schema.String),
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        filename: Schema.String,
        contentType: Schema.String,
        storageKey: Schema.String,
        sizeBytes: Schema.Number,
      }),
    ),
  ),
  inReplyToMessageId: Schema.NullOr(Schema.String),
  draftId: Schema.String,
});

const Output = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  sentAt: Schema.String,
});

export const conversationReply = defineTool({
  name: "conversation.reply",
  description:
    "Send a customer-facing reply on an existing thread. Threading is handled by `threadId` — the same connector that delivered the inbound message is the one that sends the reply, so the customer sees a natural continuation in their inbox / portal. Set `subject` to null to inherit the thread subject (`Re: <original>`). `draftId` is the idempotency key: re-running this tool with the same draftId returns the prior send instead of double-sending. Permission policy: `ask` by default — every reply requires a human approval until the agent has earned trust per-tenant.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "communicate",
  // Customer-facing replies always need a human approver until per-tenant
  // policy explicitly raises trust. PermissionService consults the tool's
  // defaultPermission unless agent-level overrides upgrade it.
  defaultPermission: "ask",
  sideEffectClass: "external_message",
  // Idempotency: the runtime's tool dispatch ties (caseId, callId) to the
  // single execution. `draftId` further binds the connector's send-side
  // dedup. Together: no double-sends across runtime retries or LLM
  // re-emissions.
  idempotencyKey: (input) => input.draftId,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const convo = yield* ConversationService;
      const sent = yield* convo
        .reply(ctx.tenantId, {
          threadId: ThreadId(input.threadId),
          to: input.to.map((p) => ({ name: p.name, email: p.email })),
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
          attachments: input.attachments ?? [],
          inReplyToMessageId: input.inReplyToMessageId,
          draftId: input.draftId,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "conversation.reply",
                issues: [e._tag],
              }),
          ),
        );
      return {
        id: sent.id,
        threadId: sent.threadId,
        sentAt: sent.sentAt.toISOString(),
      };
    }),
});
