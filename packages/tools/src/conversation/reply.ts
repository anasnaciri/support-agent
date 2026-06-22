import { Effect, Schema } from "effect";
import {
  ThreadId,
  defineTool,
  ToolOutputInvalid,
  type ConversationThread,
} from "@support-agent/agent-core";
import { ConversationService } from "@support-agent/services";

const Participant = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  email: Schema.String,
});

/**
 * Recipient constraint (audit S9). The `to` list is LLM output, and the
 * LLM's context contains the customer's (attacker-controlled) email body
 * — without this check a prompt-injected message can exfiltrate case
 * content to an arbitrary address once replies run on auto. A recipient
 * is allowed iff their address already participates in the thread
 * (thread-level participants or any message's from/to).
 *
 * Fails OPEN when the thread history is unavailable: some connectors
 * have weak `fetchThread` support, and a genuinely bogus thread id makes
 * the send itself fail. The exfiltration shape this guards against
 * (real thread, foreign recipient) always has fetchable history.
 *
 * Returns the fetched thread so the caller can REUSE it to derive the
 * reply subject — otherwise the connector would open a second connection
 * to read the same thread, which is real connection pressure on stateful
 * IMAP/SMTP providers. Returns `null` when the fetch failed (fail-open).
 */
export const assertRecipientsInThread = (
  tenantId: import("@support-agent/agent-core").TenantId,
  recipients: ReadonlyArray<{ readonly email: string }>,
  threadId: string,
  toolName: string,
  mailbox?: string,
): Effect.Effect<ConversationThread | null, ToolOutputInvalid, ConversationService> =>
  Effect.gen(function* () {
    if (mailbox) {
      const ownAddress = mailbox.trim().toLowerCase();
      const selfRecipients = recipients.filter(
        (recipient) => recipient.email.trim().toLowerCase() === ownAddress,
      );
      if (selfRecipients.length > 0) {
        return yield* Effect.fail(
          new ToolOutputInvalid({
            tool: toolName,
            issues: selfRecipients.map(
              (recipient) =>
                `recipient_is_connected_mailbox:${recipient.email}`,
            ),
          }),
        );
      }
    }
    const convo = yield* ConversationService;
    const threadEither = yield* convo
      .fetchThread(tenantId, ThreadId(threadId), mailbox)
      .pipe(Effect.either);
    if (threadEither._tag === "Left") return null;
    const thread = threadEither.right;
    const allowed = participantEmails(thread);
    const offThread = recipients.filter(
      (r) => !allowed.has(r.email.trim().toLowerCase()),
    );
    if (offThread.length > 0) {
      return yield* Effect.fail(
        new ToolOutputInvalid({
          tool: toolName,
          issues: offThread.map(
            (r) => `recipient_not_in_thread:${r.email}`,
          ),
        }),
      );
    }
    return thread;
  });

/**
 * Reply subject from an inbound subject: prefix `Re: ` unless already
 * present. Mirrors the per-connector helper, but applied at the tool layer
 * so the connector never has to read the mailbox just to learn the subject.
 */
export const replySubject = (subject: string | null | undefined): string => {
  const trimmed = (subject ?? "").trim();
  if (!trimmed) return "Re: support";
  return /^re:/iu.test(trimmed) ? trimmed : `Re: ${trimmed}`;
};

export const participantEmails = (
  thread: ConversationThread,
): ReadonlySet<string> => {
  const set = new Set<string>();
  const add = (email: string) => set.add(email.trim().toLowerCase());
  for (const p of thread.participants) add(p.email);
  for (const m of thread.messages) {
    add(m.from.email);
    for (const p of m.to) add(p.email);
  }
  return set;
};

export const requireConversationMailbox = (
  mailbox: string | undefined,
  tool: string,
): Effect.Effect<string, ToolOutputInvalid> =>
  mailbox
    ? Effect.succeed(mailbox)
    : Effect.fail(
        new ToolOutputInvalid({
          tool,
          issues: ["mailbox_not_bound"],
        }),
      );

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
    "Send a customer-facing reply on an existing thread. Threading is handled by `threadId` — the same connector that delivered the inbound message is the one that sends the reply, so the customer sees a natural continuation in their inbox / portal. Set `subject` to null to inherit the thread subject (`Re: <original>`). Recipients in `to` MUST already participate in the thread — off-thread addresses are rejected. Choose a stable `draftId` for the reply and reuse it if you retry the same send. Permission policy: `ask` by default — every reply requires a human approval until the agent has earned trust per-tenant.",
  displayName: "Send customer reply",
  displayDescription:
    "When a customer writes in, the agent drafts and sends the reply on the existing email thread.",
  tenantControl: "permission-toggle",
  inputSchema: Input,
  outputSchema: Output,
  risk: "communicate",
  // Customer-facing replies always need a human approver until per-tenant
  // policy explicitly raises trust. PermissionService consults the tool's
  // defaultPermission unless agent-level overrides upgrade it.
  defaultPermission: "ask",
  sideEffectClass: "external_message",
  idempotencyKey: (input) => input.draftId,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const mailbox = yield* requireConversationMailbox(
        ctx.mailbox,
        "conversation.reply",
      );
      const convo = yield* ConversationService;
      const thread = yield* assertRecipientsInThread(
        ctx.tenantId,
        input.to,
        input.threadId,
        "conversation.reply",
        mailbox,
      );
      // Reuse the thread already fetched for the recipient check to fill a
      // null subject, so the connector doesn't open a second connection to
      // read the same thread. Only the provider-neutral subject is reused —
      // the parent (In-Reply-To) is provider-specific, so the connector
      // still owns it.
      const subject =
        input.subject ?? (thread ? replySubject(thread.subject) : null);
      const sent = yield* convo
        .reply(ctx.tenantId, {
          threadId: ThreadId(input.threadId),
          mailbox,
          to: input.to.map((p) => ({ name: p.name, email: p.email })),
          subject,
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
