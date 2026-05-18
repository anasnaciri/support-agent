import { Effect, Schema } from "effect";
import {
  ThreadId,
  defineTool,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import { ConversationService } from "@support-agent/services";

const Input = Schema.Struct({
  threadId: Schema.String,
});

const Participant = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  email: Schema.String,
});

const Message = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  direction: Schema.Literal("inbound", "outbound"),
  from: Participant,
  to: Schema.Array(Participant),
  subject: Schema.NullOr(Schema.String),
  bodyText: Schema.String,
  bodyHtml: Schema.NullOr(Schema.String),
  sentAt: Schema.String,
  attachments: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      contentType: Schema.String,
      sizeBytes: Schema.Number,
    }),
  ),
});

const Output = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  participants: Schema.Array(Participant),
  messages: Schema.Array(Message),
});

export const conversationFetchThread = defineTool({
  name: "conversation.fetch_thread",
  description:
    "Fetch the full message history of a customer conversation thread, ordered oldest → newest. Use this when you need surrounding context before drafting a reply (the original customer message, your prior replies, the customer's follow-ups). Works against whatever connector (Gmail, Outlook, helpdesk, …) is configured for this tenant — you do not need to know which.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const convo = yield* ConversationService;
      const thread = yield* convo
        .fetchThread(ctx.tenantId, ThreadId(input.threadId))
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "conversation.fetch_thread",
                issues: [e._tag],
              }),
          ),
        );
      return {
        id: thread.id,
        subject: thread.subject,
        participants: thread.participants.map((p) => ({
          name: p.name,
          email: p.email,
        })),
        messages: thread.messages.map((m) => ({
          id: m.id,
          threadId: m.threadId,
          direction: m.direction,
          from: { name: m.from.name, email: m.from.email },
          to: m.to.map((p) => ({ name: p.name, email: p.email })),
          subject: m.subject,
          bodyText: m.bodyText,
          bodyHtml: m.bodyHtml,
          sentAt: m.sentAt.toISOString(),
          // We omit `storageKey` from the LLM-facing output — it's
          // infrastructure-level and not useful to the model.
          attachments: m.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
          })),
        })),
      };
    }),
});
