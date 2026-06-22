import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  TenantId,
  ThreadId,
  ToolOutputInvalid,
  type ConversationThread,
  type ToolContext,
} from "@support-agent/agent-core";
import {
  ConversationServiceTest,
  makeConversationServiceTest,
  TimerService,
  TimerServiceDbError,
  TimerServiceTest,
} from "@support-agent/services";
import {
  conversationAskCustomer,
  conversationFetchThread,
  conversationReply,
} from "../src/index.js";

const tenantId = TenantId("t1");
const baseCtx = (caseId: string): ToolContext => ({
  tenantId,
  caseId: CaseId(caseId),
  agentId: AgentId("support-triage"),
  callId: "call_1",
  attemptNumber: 1,
  mailbox: "support@example.com",
});

const legacyCtx = (caseId: string): ToolContext => {
  const { mailbox: _mailbox, ...ctx } = baseCtx(caseId);
  return ctx;
};

const seedThread = (id: string): ConversationThread => ({
  id: ThreadId(id),
  subject: "Where is my order?",
  participants: [
    { name: "Jane Doe", email: "customer@example.com" },
    { name: "Support", email: "support@example.com" },
  ],
  messages: [
    {
      id: "msg-1",
      threadId: ThreadId(id),
      direction: "inbound",
      from: { name: "Jane Doe", email: "customer@example.com" },
      to: [{ name: "Support", email: "support@example.com" }],
      subject: "Where is my order?",
      bodyText: "Hi, I haven't seen #1001 yet.",
      bodyHtml: null,
      sentAt: new Date("2026-05-14T10:00:00.000Z"),
      attachments: [],
    },
  ],
});

describe("conversation.fetch_thread tool", () => {
  it("returns a flattened thread on success", async () => {
    const env = ConversationServiceTest({
      threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationFetchThread.execute(
          { threadId: "thread-1" } as never,
          baseCtx("c-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["id"]).toBe("thread-1");
    expect(result["subject"]).toBe("Where is my order?");
    const messages = result["messages"] as ReadonlyArray<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    // Dates serialized to ISO strings for the LLM-facing shape.
    expect(messages[0]!["sentAt"]).toBe("2026-05-14T10:00:00.000Z");
    expect(messages[0]!["direction"]).toBe("inbound");
  });

  it("maps ThreadNotFound to ToolOutputInvalid", async () => {
    const env = ConversationServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationFetchThread.execute(
          { threadId: "nope" } as never,
          baseCtx("c-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("conversation.fetch_thread");
        expect(err.issues).toEqual(["ThreadNotFound"]);
      }
    }
  });

  it("fails closed when the case is not bound to a mailbox", async () => {
    const env = ConversationServiceTest({
      threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationFetchThread.execute(
          { threadId: "thread-1" } as never,
          legacyCtx("c-legacy-fetch"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.issues).toEqual(["mailbox_not_bound"]);
      }
    }
  });
});

describe("conversation.reply tool", () => {
  it("sends through the conversation service and returns the SentMessage shape", async () => {
    const { layer, handle } = makeConversationServiceTest({
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationReply.execute(
          {
            threadId: "thread-1",
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "Your order is in transit.",
            bodyHtml: null,
            inReplyToMessageId: "msg-1",
            draftId: "draft-1",
          } as never,
          baseCtx("c-r"),
        ) as Effect.Effect<unknown, unknown, never>,
        layer,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value).toEqual({
      id: "sent-1",
      threadId: "thread-1",
      sentAt: "2026-05-16T12:00:00.000Z",
    });
    // The connector got the call with the right tenantId + draftId.
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]!.kind).toBe("reply");
    expect(handle.sent[0]!.tenantId).toBe(tenantId);
  });

  it("fails closed when the case is not bound to a mailbox", async () => {
    const { layer, handle } = makeConversationServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationReply.execute(
          {
            threadId: "thread-1",
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "Your order is in transit.",
            bodyHtml: null,
            inReplyToMessageId: "msg-1",
            draftId: "draft-legacy",
          } as never,
          legacyCtx("c-legacy-reply"),
        ) as Effect.Effect<unknown, unknown, never>,
        layer,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(handle.sent).toHaveLength(0);
  });

  it("reuses the recipient-check thread to fill a null subject", async () => {
    // The tool already fetches the thread once for the S9 recipient check;
    // reuse it to derive `Re: <subject>` so the IMAP connector doesn't open a
    // SECOND connection to read the same thread just for the subject line.
    const { layer, handle } = makeConversationServiceTest({
      threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationReply.execute(
          {
            threadId: "thread-1",
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "Your order is in transit.",
            bodyHtml: null,
            inReplyToMessageId: null,
            draftId: "draft-subj",
          } as never,
          baseCtx("c-subj"),
        ) as Effect.Effect<unknown, unknown, never>,
        layer,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]!.input.subject).toBe("Re: Where is my order?");
  });

  it("passes an explicit subject through unchanged", async () => {
    const { layer, handle } = makeConversationServiceTest({
      threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationReply.execute(
          {
            threadId: "thread-1",
            to: [{ name: null, email: "customer@example.com" }],
            subject: "Re: custom subject",
            bodyText: "Hello.",
            bodyHtml: null,
            inReplyToMessageId: null,
            draftId: "draft-subj2",
          } as never,
          baseCtx("c-subj2"),
        ) as Effect.Effect<unknown, unknown, never>,
        layer,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(handle.sent[0]!.input.subject).toBe("Re: custom subject");
  });

  it("leaves the subject null when the thread is unavailable (connector derives it)", async () => {
    // No thread seeded → the recipient check fails open → no subject to reuse.
    // The connector's own best-effort read remains the fallback.
    const { layer, handle } = makeConversationServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationReply.execute(
          {
            threadId: "thread-1",
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "Hello.",
            bodyHtml: null,
            inReplyToMessageId: null,
            draftId: "draft-subj3",
          } as never,
          baseCtx("c-subj3"),
        ) as Effect.Effect<unknown, unknown, never>,
        layer,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]!.input.subject).toBeNull();
  });

  it("refuses to send a customer reply to the connected mailbox itself", async () => {
    const { layer, handle } = makeConversationServiceTest({
      threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationReply.execute(
          {
            threadId: "thread-1",
            to: [{ name: "Support", email: "support@example.com" }],
            subject: null,
            bodyText: "This must not be sent to ourselves.",
            bodyHtml: null,
            inReplyToMessageId: "msg-1",
            draftId: "draft-self",
          } as never,
          baseCtx("c-self-reply"),
        ) as Effect.Effect<unknown, unknown, never>,
        layer,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.issues).toEqual([
          "recipient_is_connected_mailbox:support@example.com",
        ]);
      }
    }
    expect(handle.sent).toHaveLength(0);
  });

  it("declares an idempotencyKey derived from draftId", () => {
    // Master-plan §9: state-changing tools MUST surface an idempotency
    // key so the runtime can dedupe retries before re-invoking the body.
    const key = conversationReply.idempotencyKey?.({
      threadId: "thread-1",
      to: [],
      subject: null,
      bodyText: "",
      bodyHtml: null,
      inReplyToMessageId: null,
      draftId: "draft-42",
    } as never);
    expect(key).toBe("draft-42");
  });

  it("default permission is `ask` — customer-facing sends require approval until trust is built", () => {
    expect(conversationReply.defaultPermission).toBe("ask");
    expect(conversationReply.sideEffectClass).toBe("external_message");
  });

  // Audit S9 — the recipient list is LLM output and the LLM's context
  // contains the (attacker-controlled) inbound email. Without a
  // participant constraint, a prompt-injected email can exfiltrate case
  // content to an arbitrary address the moment replies run on auto.
  describe("recipient constraint (audit S9)", () => {
    const replyInput = (email: string) =>
      ({
        threadId: "thread-1",
        to: [{ name: null, email }],
        subject: null,
        bodyText: "Order details inside.",
        bodyHtml: null,
        inReplyToMessageId: "msg-1",
        draftId: "draft-s9",
      }) as never;

    it("refuses a recipient that is not a participant of the thread", async () => {
      const { layer, handle } = makeConversationServiceTest({
        threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
      });
      const exit = await Effect.runPromiseExit(
        Effect.provide(
          conversationReply.execute(
            replyInput("attacker@evil.example"),
            baseCtx("c-s9"),
          ) as Effect.Effect<unknown, unknown, never>,
          layer,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      // Nothing went out over the wire.
      expect(handle.sent).toHaveLength(0);
    });

    it("allows a recipient who participates in the thread", async () => {
      const { layer, handle } = makeConversationServiceTest({
        threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
      });
      const exit = await Effect.runPromiseExit(
        Effect.provide(
          conversationReply.execute(
            replyInput("customer@example.com"),
            baseCtx("c-s9b"),
          ) as Effect.Effect<unknown, unknown, never>,
          layer,
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(handle.sent).toHaveLength(1);
    });

    it("fails open when the thread history is unavailable (connector without fetch support)", async () => {
      // No seeded thread → fetchThread fails. The constraint can only be
      // enforced when history is available; the connector's own send will
      // fail on a genuinely bogus thread.
      const { layer, handle } = makeConversationServiceTest({});
      const exit = await Effect.runPromiseExit(
        Effect.provide(
          conversationReply.execute(
            replyInput("customer@example.com"),
            baseCtx("c-s9c"),
          ) as Effect.Effect<unknown, unknown, never>,
          layer,
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(handle.sent).toHaveLength(1);
    });
  });
});

describe("conversation.ask_customer tool", () => {
  it("sends through askCustomer (not reply) and records the kind", async () => {
    const { layer, handle } = makeConversationServiceTest({});
    await Effect.runPromise(
      Effect.provide(
        conversationAskCustomer.execute(
          {
            threadId: "thread-1",
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "Can you confirm the order number?",
            bodyHtml: null,
            draftId: "ask-1",
          } as never,
          baseCtx("c-a"),
        ) as Effect.Effect<unknown, unknown, never>,
        layer,
      ),
    );
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]!.kind).toBe("askCustomer");
  });

  it("reuses the recipient-check thread to fill a null subject", async () => {
    const { layer, handle } = makeConversationServiceTest({
      threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
    });
    await Effect.runPromise(
      Effect.provide(
        conversationAskCustomer.execute(
          {
            threadId: "thread-1",
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "What is your order number?",
            bodyHtml: null,
            draftId: "ask-subj",
          } as never,
          baseCtx("c-ask-subj"),
        ) as Effect.Effect<unknown, unknown, never>,
        layer,
      ),
    );
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]!.input.subject).toBe("Re: Where is my order?");
  });

  it("fails closed when the case is not bound to a mailbox", async () => {
    const { layer, handle } = makeConversationServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationAskCustomer.execute(
          {
            threadId: "thread-1",
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "Can you confirm the order number?",
            bodyHtml: null,
            draftId: "ask-legacy",
          } as never,
          legacyCtx("c-legacy-ask"),
        ) as Effect.Effect<unknown, unknown, never>,
        layer,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(handle.sent).toHaveLength(0);
  });

  it("schedules a follow-up timer when remindAfterHours is present", async () => {
    const { layer: conversationLayer, handle } = makeConversationServiceTest({});
    const env = Layer.merge(conversationLayer, TimerServiceTest);
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* conversationAskCustomer.execute(
            {
              threadId: "thread-1",
              to: [{ name: null, email: "customer@example.com" }],
              subject: null,
              bodyText: "Can you confirm the order number?",
              bodyHtml: null,
              remindAfterHours: 2,
              draftId: "ask-reminder",
            } as never,
            baseCtx("c-reminder"),
          );
          const timers = yield* TimerService;
          return yield* timers.listDue(
            new Date(Date.now() + 3 * 60 * 60 * 1000),
          );
        }) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );

    const due = result as ReadonlyArray<Record<string, unknown>>;
    expect(handle.sent).toHaveLength(1);
    expect(due).toHaveLength(1);
    expect(due[0]!["caseId"]).toBe(CaseId("c-reminder"));
    expect(due[0]!["reason"]).toBe("follow_up");
  });

  it("maps follow-up timer failures to ToolOutputInvalid", async () => {
    const { layer: conversationLayer } = makeConversationServiceTest({});
    const timerLayer = Layer.succeed(TimerService, {
      schedule: () =>
        Effect.fail(
          new TimerServiceDbError({
            operation: "schedule",
            cause: new Error("db unavailable"),
          }),
        ),
      cancelOpenForCase: () => Effect.succeed(0),
      listDue: () => Effect.succeed([]),
      markFired: () => Effect.succeed(undefined as void),
    });
    const env = Layer.merge(conversationLayer, timerLayer);

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        conversationAskCustomer.execute(
          {
            threadId: "thread-1",
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "Can you confirm the order number?",
            bodyHtml: null,
            remindAfterHours: 2,
            draftId: "ask-timer-failure",
          } as never,
          baseCtx("c-timer-failure"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("conversation.ask_customer");
        expect(err.issues).toEqual(["TimerServiceDbError"]);
      }
    }
  });

  it("default permission is `allow` — clarifying questions are routine", () => {
    expect(conversationAskCustomer.defaultPermission).toBe("allow");
  });

  // ask_customer auto-executes (`allow`), so the S9 recipient constraint
  // matters even more here than on reply: a prompt-injected clarifying
  // question could otherwise exfiltrate to an arbitrary address with no
  // human in the loop. Same `assertRecipientsInThread` guard as reply.
  describe("recipient constraint (audit S9)", () => {
    const askInput = (email: string) =>
      ({
        threadId: "thread-1",
        to: [{ name: null, email }],
        subject: null,
        bodyText: "Can you confirm the order number?",
        bodyHtml: null,
        draftId: "ask-s9",
      }) as never;

    it("refuses a recipient that is not a participant of the thread", async () => {
      const { layer, handle } = makeConversationServiceTest({
        threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
      });
      const exit = await Effect.runPromiseExit(
        Effect.provide(
          conversationAskCustomer.execute(
            askInput("attacker@evil.example"),
            baseCtx("c-ask-s9"),
          ) as Effect.Effect<unknown, unknown, never>,
          layer,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(handle.sent).toHaveLength(0);
    });

    it("allows a recipient who participates in the thread", async () => {
      const { layer, handle } = makeConversationServiceTest({
        threads: new Map([[`${tenantId}:thread-1`, seedThread("thread-1")]]),
      });
      const exit = await Effect.runPromiseExit(
        Effect.provide(
          conversationAskCustomer.execute(
            askInput("customer@example.com"),
            baseCtx("c-ask-s9b"),
          ) as Effect.Effect<unknown, unknown, never>,
          layer,
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(handle.sent).toHaveLength(1);
    });
  });
});
