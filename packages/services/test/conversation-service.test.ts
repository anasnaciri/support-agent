import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  TenantId,
  ThreadId,
  ThreadNotFound,
  type ConversationThread,
} from "@support-agent/agent-core";
import {
  ConversationService,
  ConversationServiceTest,
  makeConversationServiceTest,
} from "../src/conversation-service.js";

const tenantId = TenantId("t1");

const buildThread = (id: string): ConversationThread => ({
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

describe("ConversationServiceTest", () => {
  it("fetchThread returns a seeded thread", async () => {
    const layer = ConversationServiceTest({
      threads: new Map([[`${tenantId}:thread-1`, buildThread("thread-1")]]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) =>
          s.fetchThread(tenantId, ThreadId("thread-1")),
        ),
        layer,
      ),
    );
    expect(result.id).toBe("thread-1");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.direction).toBe("inbound");
  });

  it("fetchThread fails with ThreadNotFound on a miss", async () => {
    const layer = ConversationServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) =>
          s.fetchThread(tenantId, ThreadId("nope")),
        ),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ThreadNotFound);
  });

  it("reply records the send and returns a SentMessage with a deterministic id", async () => {
    const { layer, handle } = makeConversationServiceTest({
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    });
    const sent = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) =>
          s.reply(tenantId, {
            threadId: ThreadId("thread-1"),
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "Your order is in transit.",
            bodyHtml: null,
            attachments: [],
            inReplyToMessageId: "msg-1",
            draftId: "draft-1",
          }),
        ),
        layer,
      ),
    );
    expect(sent.id).toBe("sent-1");
    expect(sent.threadId).toBe("thread-1");
    expect(sent.sentAt.toISOString()).toBe("2026-05-16T12:00:00.000Z");

    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]!.kind).toBe("reply");
    expect(handle.sent[0]!.tenantId).toBe(tenantId);
  });

  it("askCustomer records the send under kind='askCustomer'", async () => {
    const { layer, handle } = makeConversationServiceTest({});
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) =>
          s.askCustomer(tenantId, {
            threadId: ThreadId("thread-1"),
            to: [{ name: null, email: "customer@example.com" }],
            subject: null,
            bodyText: "Can you confirm your order number?",
            bodyHtml: null,
            attachments: [],
            draftId: "ask-1",
          }),
        ),
        layer,
      ),
    );
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]!.kind).toBe("askCustomer");
  });

  it("compose: ConversationServiceTest convenience wraps the layer", () => {
    const layer = ConversationServiceTest({});
    // Type-only assertion: building the layer shouldn't error.
    expect(Layer.isLayer(layer)).toBe(true);
  });
});
