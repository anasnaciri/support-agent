import { Effect, Exit } from "effect";
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
});

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

  it("default permission is `allow` — clarifying questions are routine", () => {
    expect(conversationAskCustomer.defaultPermission).toBe("allow");
  });
});
