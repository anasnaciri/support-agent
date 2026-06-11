import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  ConversationAuthMissing,
  ConversationProviderUnavailable,
  TenantId,
  ThreadId,
  ThreadNotFound,
  type ConversationReply,
  type ConversationThread,
  type SentMessage,
} from "@support-agent/agent-core";
import {
  type ConnectorProvider,
  type ConversationServiceShape,
} from "@support-agent/services";
import { makeConversationRouter } from "../src/conversation-router-live.js";

const tenantA = TenantId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

// A fake conversation impl that records the thread id it was handed and tags
// every result with its provider name, so tests can assert BOTH which
// connector the router delegated to AND that the prefix was stripped.
const fakeImpl = (
  name: string,
): ConversationServiceShape & { readonly seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    fetchThread: (_tenantId, threadId) => {
      seen.push(threadId);
      return Effect.succeed({
        id: threadId,
        subject: name,
        participants: [],
        messages: [
          {
            id: `${name}-m1`,
            threadId,
            direction: "inbound",
            from: { name: null, email: "jane@example.com" },
            to: [],
            subject: null,
            bodyText: "hello",
            bodyHtml: null,
            sentAt: new Date(0),
            attachments: [],
          },
        ],
      } satisfies ConversationThread);
    },
    reply: (_tenantId, input) => {
      seen.push(input.threadId);
      return Effect.succeed({
        id: `${name}-sent`,
        threadId: input.threadId,
        sentAt: new Date(0),
      } satisfies SentMessage);
    },
    askCustomer: (_tenantId, input) => {
      seen.push(input.threadId);
      return Effect.succeed({
        id: `${name}-ask`,
        threadId: input.threadId,
        sentAt: new Date(0),
      } satisfies SentMessage);
    },
  };
};

const reply = (threadId: string): ConversationReply => ({
  threadId: ThreadId(threadId),
  to: [{ name: null, email: "jane@example.com" }],
  subject: null,
  bodyText: "hi",
  bodyHtml: null,
  attachments: [],
  inReplyToMessageId: null,
  draftId: "d1",
});

const setup = () => {
  const gmail = fakeImpl("gmail");
  const outlook = fakeImpl("outlook");
  const router = makeConversationRouter(
    new Map<ConnectorProvider, ConversationServiceShape>([
      ["gmail", gmail],
      ["outlook", outlook],
    ]),
  );
  return { gmail, outlook, router };
};

describe("makeConversationRouter (thread-id prefix dispatch)", () => {
  it("dispatches gmail:<id> to the gmail impl with the prefix stripped", async () => {
    const { gmail, router } = setup();
    const thread = await Effect.runPromise(
      router.fetchThread(tenantA, ThreadId("gmail:t1")),
    );
    expect(thread.subject).toBe("gmail");
    expect(gmail.seen).toEqual(["t1"]);
  });

  it("dispatches outlook:<id> to the outlook impl", async () => {
    const { outlook, router } = setup();
    const sent = await Effect.runPromise(
      router.reply(tenantA, reply("outlook:AQQk=")),
    );
    expect(sent.id).toBe("outlook-sent");
    expect(outlook.seen).toEqual(["AQQk="]);
  });

  it("a single tenant reaches BOTH providers — multi-mailbox", async () => {
    const { gmail, outlook, router } = setup();
    await Effect.runPromise(router.reply(tenantA, reply("gmail:g1")));
    await Effect.runPromise(router.reply(tenantA, reply("outlook:o1")));
    expect(gmail.seen).toEqual(["g1"]);
    expect(outlook.seen).toEqual(["o1"]);
  });

  it("askCustomer dispatches by prefix too", async () => {
    const { outlook, router } = setup();
    const sent = await Effect.runPromise(
      router.askCustomer(tenantA, { ...reply("outlook:o2") }),
    );
    expect(sent.id).toBe("outlook-ask");
    expect(outlook.seen).toEqual(["o2"]);
  });

  it("re-namespaces ids on fetched threads and sent messages", async () => {
    const { router } = setup();
    const thread = await Effect.runPromise(
      router.fetchThread(tenantA, ThreadId("gmail:t1")),
    );
    expect(thread.id).toBe("gmail:t1");
    expect(thread.messages[0]!.threadId).toBe("gmail:t1");
    const sent = await Effect.runPromise(
      router.reply(tenantA, reply("gmail:t1")),
    );
    expect(sent.threadId).toBe("gmail:t1");
  });

  it("keeps colons inside the raw id intact", async () => {
    const { gmail, router } = setup();
    await Effect.runPromise(
      router.fetchThread(tenantA, ThreadId("gmail:<a:b@x.com>")),
    );
    expect(gmail.seen).toEqual(["<a:b@x.com>"]);
  });

  it("fails ThreadNotFound for an un-namespaced thread id", async () => {
    const { router } = setup();
    const exit = await Effect.runPromiseExit(
      router.fetchThread(tenantA, ThreadId("19e9ad3a3f896575")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ThreadNotFound);
  });

  it("fails ThreadNotFound for an unknown provider prefix", async () => {
    const { router } = setup();
    const exit = await Effect.runPromiseExit(
      router.reply(tenantA, reply("helpdesk:123")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ThreadNotFound);
  });

  it("fails ConversationAuthMissing when the provider has no installed impl", async () => {
    // imap is a valid conversation provider, but this deployment has no
    // imap builder configured.
    const { router } = setup();
    const exit = await Effect.runPromiseExit(
      router.fetchThread(tenantA, ThreadId("imap:<m1@x.com>")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ConversationAuthMissing);
    expect((err as ConversationAuthMissing).provider).toBe("imap");
  });

  it("remaps a connector's ThreadNotFound back to the namespaced id", async () => {
    const failing: ConversationServiceShape = {
      fetchThread: (tenantId, threadId) =>
        Effect.fail(new ThreadNotFound({ threadId, tenantId })),
      reply: () => Effect.die("unused"),
      askCustomer: () => Effect.die("unused"),
    };
    const router = makeConversationRouter(
      new Map<ConnectorProvider, ConversationServiceShape>([
        ["gmail", failing],
      ]),
    );
    const exit = await Effect.runPromiseExit(
      router.fetchThread(tenantA, ThreadId("gmail:gone")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ThreadNotFound);
    expect((err as ThreadNotFound).threadId).toBe("gmail:gone");
  });

  it("rejects a connector response for a different raw thread", async () => {
    const mismatched: ConversationServiceShape = {
      fetchThread: () =>
        Effect.succeed({
          id: ThreadId("other-thread"),
          subject: "wrong",
          participants: [],
          messages: [
            {
              id: "m-1",
              threadId: ThreadId("other-thread"),
              direction: "inbound",
              from: { name: null, email: "other@example.com" },
              to: [],
              subject: "wrong",
              bodyText: "wrong",
              bodyHtml: null,
              sentAt: new Date(0),
              attachments: [],
            },
          ],
        }),
      reply: () => Effect.die("unused"),
      askCustomer: () => Effect.die("unused"),
    };
    const router = makeConversationRouter(
      new Map<ConnectorProvider, ConversationServiceShape>([
        ["gmail", mismatched],
      ]),
    );
    const exit = await Effect.runPromiseExit(
      router.fetchThread(tenantA, ThreadId("gmail:expected-thread")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ConversationProviderUnavailable);
  });
});
