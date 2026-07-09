import { Effect, Schema } from "effect";
import {
  ThreadId,
  defineTool,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import { ConversationService, TimerService } from "@support-agent/services";
import {
  assertRecipientsInThread,
  replySubject,
  requireConversationMailbox,
  resolveDraftAttachmentIds,
} from "./reply.js";

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
  // Opaque ticket-attachment ids; resolved server-side within this ticket
  // only (see conversation.reply).
  attachmentIds: Schema.optional(Schema.Array(Schema.String)),
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
    "Ask the customer a clarifying question. After this tool runs, the ticket will transition to `waiting_for_customer` and the workflow tick ends; when the customer replies, a new `customer.replied` event resumes the ticket. Use this when you genuinely need information you cannot derive (an order number you couldn't find, a clarification on what went wrong) — do NOT use it to delay a reply you could already write. `draftId` is the idempotency key. `remindAfterHours`, if set, schedules an SLA follow-up timer.",
  displayDescription:
    "The agent sends a clarifying question to the customer to move the ticket forward.",
  tenantControl: "permission-toggle",
  inputSchema: Input,
  outputSchema: Output,
  risk: "communicate",
  defaultPermission: "allow",
  sideEffectClass: "external_message",
  idempotencyKey: (input) => input.draftId,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const remindAfterHours = input.remindAfterHours;
      const mailbox = yield* requireConversationMailbox(
        ctx.mailbox,
        "conversation.ask_customer",
      );
      const convo = yield* ConversationService;
      // Recipient constraint (audit S9) — same rule as conversation.reply.
      const thread = yield* assertRecipientsInThread(
        ctx.tenantId,
        input.to,
        input.threadId,
        "conversation.ask_customer",
        mailbox,
      );
      // Reuse the recipient-check thread to fill a null subject (saves the
      // connector a second read of the same thread); see conversation.reply.
      const subject =
        input.subject ?? (thread ? replySubject(thread.subject) : null);
      const attachments = yield* resolveDraftAttachmentIds(
        ctx.tenantId,
        ctx.ticketId,
        input.attachmentIds,
        "conversation.ask_customer",
      );
      const sent = yield* convo
        .askCustomer(ctx.tenantId, {
          threadId: ThreadId(input.threadId),
          mailbox,
          to: input.to.map((p) => ({ name: p.name, email: p.email })),
          subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
          attachments,
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
            ticketId: ctx.ticketId,
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
