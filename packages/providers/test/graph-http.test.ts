import { describe, expect, it, vi } from "vitest";
import {
  GraphHttpError,
  graphCreateSubscription,
  graphGetConversation,
  graphGetMessage,
  graphRenewSubscription,
  graphSendDraft,
  type GraphHttpFailure,
} from "../src/graph-http.js";

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const fail = (status: number, headers: Record<string, string> = {}): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => "boom",
    headers: new Headers(headers),
  }) as unknown as Response;

const empty202 = (): Response =>
  ({
    ok: true,
    status: 202,
    json: async () => ({}),
    text: async () => "",
    headers: new Headers(),
  }) as unknown as Response;

const mailbox = "support@merchant.com";

describe("graphGetConversation", () => {
  it("escapes single quotes in the conversationId filter and sorts oldest → newest", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("conversationId%20eq%20'o''brien'");
      return okJson({
        value: [
          {
            id: "m-2",
            subject: "Re: hi",
            from: { emailAddress: { address: "jane@example.com" } },
            sentDateTime: "2026-06-02T00:00:00Z",
            body: { contentType: "text", content: "later" },
          },
          {
            id: "m-1",
            subject: "hi",
            from: { emailAddress: { address: "jane@example.com" } },
            sentDateTime: "2026-06-01T00:00:00Z",
            body: { contentType: "text", content: "first" },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const thread = await graphGetConversation({
      token: "t",
      conversationId: "o'brien",
      mailbox,
      fetchImpl,
    });
    expect(thread.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    expect(thread.subject).toBe("hi");
  });

  it("strips HTML tags into bodyText when content is HTML", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        value: [
          {
            id: "m-1",
            from: { emailAddress: { address: "jane@example.com" } },
            sentDateTime: "2026-06-01T00:00:00Z",
            body: { contentType: "html", content: "<p>Hello <b>there</b></p>" },
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const thread = await graphGetConversation({
      token: "t",
      conversationId: "c",
      mailbox,
      fetchImpl,
    });
    expect(thread.messages[0]!.bodyText).toBe("Hello  there");
    expect(thread.messages[0]!.bodyHtml).toBe("<p>Hello <b>there</b></p>");
  });

  it("excludes reply drafts from the customer conversation thread", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        value: [
          {
            id: "draft-1",
            conversationId: "c",
            isDraft: true,
            from: { emailAddress: { address: mailbox } },
            toRecipients: [{ emailAddress: { address: "jane@example.com" } }],
            sentDateTime: "2026-06-01T01:00:00Z",
            body: { contentType: "text", content: "draft copy" },
          },
          {
            id: "sent-1",
            conversationId: "c",
            isDraft: false,
            from: { emailAddress: { address: mailbox } },
            toRecipients: [{ emailAddress: { address: "jane@example.com" } }],
            sentDateTime: "2026-06-01T01:00:00Z",
            body: { contentType: "text", content: "sent copy" },
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const thread = await graphGetConversation({
      token: "t",
      conversationId: "c",
      mailbox,
      fetchImpl,
    });

    expect(thread.messages.map((message) => message.id)).toEqual(["sent-1"]);
  });

  const cases: ReadonlyArray<{ status: number; kind: GraphHttpFailure["kind"] }> = [
    { status: 401, kind: "auth_failed" },
    { status: 403, kind: "auth_failed" },
    { status: 404, kind: "not_found" },
    { status: 500, kind: "network" },
  ];
  for (const c of cases) {
    it(`maps HTTP ${c.status} → ${c.kind}`, async () => {
      const fetchImpl = vi.fn(async () => fail(c.status)) as unknown as typeof fetch;
      await expect(
        graphGetConversation({ token: "t", conversationId: "c", mailbox, fetchImpl }),
      ).rejects.toMatchObject({ failure: { kind: c.kind } });
    });
  }

  it("maps 429 → rate_limited with retryAfterMs from the retry-after header", async () => {
    const fetchImpl = vi.fn(async () =>
      fail(429, { "retry-after": "3" }),
    ) as unknown as typeof fetch;
    try {
      await graphGetConversation({ token: "t", conversationId: "c", mailbox, fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphHttpError);
      expect((err as GraphHttpError).failure).toEqual({
        kind: "rate_limited",
        retryAfterMs: 3000,
      });
    }
  });
});

describe("graphSendDraft", () => {
  it("resolves on a 202 with no body", async () => {
    const fetchImpl = vi.fn(async () => empty202()) as unknown as typeof fetch;
    await expect(
      graphSendDraft({ token: "t", draftId: "d", fetchImpl }),
    ).resolves.toBeUndefined();
  });
});

describe("graphGetMessage", () => {
  it("normalises a single message by id (inbound from the customer)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/me/messages/m-1");
      return okJson({
        id: "m-1",
        conversationId: "conv-1",
        subject: "hi",
        from: { emailAddress: { address: "jane@example.com" } },
        toRecipients: [{ emailAddress: { address: mailbox } }],
        body: { contentType: "text", content: "hello" },
        sentDateTime: "2026-06-01T00:00:00Z",
      });
    }) as unknown as typeof fetch;
    const msg = await graphGetMessage({
      token: "t",
      messageId: "m-1",
      mailbox,
      fetchImpl,
    });
    expect(msg.id).toBe("m-1");
    expect(msg.threadId).toBe("conv-1");
    expect(msg.direction).toBe("inbound");
    expect(msg.bodyText).toBe("hello");
  });

  it("marks a message sent by the mailbox itself as outbound", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        id: "m-2",
        conversationId: "conv-1",
        from: { emailAddress: { address: mailbox } },
        body: { contentType: "text", content: "our reply" },
        sentDateTime: "2026-06-01T01:00:00Z",
      }),
    ) as unknown as typeof fetch;
    const msg = await graphGetMessage({
      token: "t",
      messageId: "m-2",
      mailbox,
      fetchImpl,
    });
    expect(msg.direction).toBe("outbound");
  });
});

describe("graph subscriptions", () => {
  it("creates a subscription with the inbox resource + clientState", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["changeType"]).toBe("created");
      expect(body["notificationUrl"]).toBe(
        "https://api.example.com/webhooks/conversations/outlook/t1",
      );
      expect(body["clientState"]).toBe("secret");
      expect(String(body["resource"]).toLowerCase()).toContain("inbox");
      return okJson({ id: "sub-1", expirationDateTime: "2026-06-05T00:00:00Z" });
    }) as unknown as typeof fetch;
    const sub = await graphCreateSubscription({
      token: "t",
      notificationUrl: "https://api.example.com/webhooks/conversations/outlook/t1",
      clientState: "secret",
      expirationDateTime: "2026-06-05T00:00:00Z",
      fetchImpl,
    });
    expect(sub).toEqual({ id: "sub-1", expirationDateTime: "2026-06-05T00:00:00Z" });
  });

  it("renews an existing subscription via PATCH", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PATCH");
      expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions/sub-1");
      return okJson({ id: "sub-1", expirationDateTime: "2026-06-09T00:00:00Z" });
    }) as unknown as typeof fetch;
    const sub = await graphRenewSubscription({
      token: "t",
      subscriptionId: "sub-1",
      expirationDateTime: "2026-06-09T00:00:00Z",
      fetchImpl,
    });
    expect(sub.expirationDateTime).toBe("2026-06-09T00:00:00Z");
  });
});
