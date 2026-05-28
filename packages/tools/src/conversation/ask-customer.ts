import { Effect, Schema } from "effect";
import {
  ThreadId,
  defineTool,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import { ConversationService, TimerService } from "@support-agent/services";

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
  remindAfterHours: Schema.optional(Schema.Number),
  draftId: Schema.String,
});

const Output = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  sentAt: Schema.String,
});

const toToolOutputInvalid = (tag: string) =>
  new ToolOutputInvalid({
    tool: "conversation.ask_customer",
    issues: [tag],
  });

export const conversationAskCustomer = defineTool({
  name: "conversation.ask_customer",
  description:
    "Ask the customer a clarifying question. After this tool runs, the case will transition to `waiting_for_customer` and the workflow tick ends; when the customer replies, a new `customer.replied` event resumes the case. Use this when you genuinely need information you cannot derive (an order number you couldn't find, a clarification on what went wrong) — do NOT use it to delay a reply you could already write. `draftId` is the idempotency key. `remindAfterHours`, if set, schedules an SLA follow-up timer.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "communicate",
  defaultPermission: "allow",
  sideEffectClass: "external_message",
  idempotencyKey: (input) => input.draftId,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const remindAfterHours = input.remindAfterHours;
      const convo = yield* ConversationService;
      const sent = yield* convo
        .askCustomer(ctx.tenantId, {
          threadId: ThreadId(input.threadId),
          to: input.to.map((p) => ({ name: p.name, email: p.email })),
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
          attachments: input.attachments ?? [],
          ...(remindAfterHours !== undefined ? { remindAfterHours } : {}),
          draftId: input.draftId,
        })
        .pipe(Effect.mapError((e) => toToolOutputInvalid(e._tag)));
      if (
        remindAfterHours !== undefined &&
        Number.isFinite(remindAfterHours) &&
        remindAfterHours > 0
      ) {
        const timers = yield* TimerService;
        yield* timers
          .schedule({
            caseId: ctx.caseId,
            fireAt: new Date(Date.now() + remindAfterHours * 60 * 60 * 1000),
            reason: "follow_up",
          })
          .pipe(Effect.mapError((e) => toToolOutputInvalid(e._tag)));
      }
      return {
        id: sent.id,
        threadId: sent.threadId,
        sentAt: sent.sentAt.toISOString(),
      };
    }),
});
