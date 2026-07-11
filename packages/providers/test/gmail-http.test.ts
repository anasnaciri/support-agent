import { describe, expect, it, vi } from "vitest";
import {
  buildGmailMime,
  gmailGetMessage,
  gmailGetProfile,
  gmailGetThread,
  gmailListHistory,
  gmailListInboxMessageIds,
  gmailMarkMessageRead,
  gmailSendMessage,
  GmailHttpError,
  toInboundMessage,
} from "../src/gmail-http.js";

const b64url = (s: string) =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const fail = (status: number, body = ""): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    headers: new Headers(),
  }) as unknown as Response;

describe("gmailGetThread — normalisation", () => {
  it("parses participants from From/To headers, joins multipart bodies, and surfaces direction", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        id: "thread-1",
        historyId: "9001",
        messages: [
          {
            id: "msg-1",
            threadId: "thread-1",
            labelIds: ["INBOX"],
            internalDate: "1747000000000",
            payload: {
              headers: [
                { name: "From", value: '"Jane Doe" <jane@example.com>' },
                {
                  name: "To",
                  value: "support@merchant.com, billing@merchant.com",
                },
                { name: "Subject", value: "Where is my order?" },
                { name: "Message-ID", value: "<msg-1@example.com>" },
              ],
              parts: [
                {
                  mimeType: "text/plain",
                  body: { data: b64url("Hi, where is #1001?") },
                },
                {
                  mimeType: "text/html",
                  body: { data: b64url("<p>Hi, where is #1001?</p>") },
                },
              ],
            },
          },
          {
            id: "msg-2",
            threadId: "thread-1",
            labelIds: ["SENT"],
            internalDate: "1747000060000",
            payload: {
              headers: [
                { name: "From", value: "support@merchant.com" },
                { name: "To", value: "jane@example.com" },
                { name: "Subject", value: "Re: Where is my order?" },
                { name: "Message-ID", value: "<msg-2@example.com>" },
                { name: "References", value: "<msg-1@example.com>" },
              ],
              body: { data: b64url("Tracking is #ABC123") },
            },
          },
        ],
      }),
    );
    const thread = await gmailGetThread({
      token: "tok",
      threadId: "thread-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(thread.id).toBe("thread-1");
    expect(thread.subject).toBe("Where is my order?");
    expect(thread.historyId).toBe("9001");
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]!.direction).toBe("inbound");
    expect(thread.messages[1]!.direction).toBe("outbound");
    expect(thread.messages[0]!.from).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
    });
    expect(thread.messages[0]!.to.map((p) => p.email)).toEqual([
      "support@merchant.com",
      "billing@merchant.com",
    ]);
    expect(thread.messages[0]!.bodyText).toBe("Hi, where is #1001?");
    expect(thread.messages[0]!.bodyHtml).toBe("<p>Hi, where is #1001?</p>");
    expect(thread.messages[0]!.rfcMessageId).toBe("msg-1@example.com");
    expect(thread.messages[1]!.rfcMessageId).toBe("msg-2@example.com");
    expect(thread.messages[1]!.references).toEqual(["msg-1@example.com"]);
    // Participants deduped across the thread, first-seen order.
    expect(thread.participants.map((p) => p.email)).toEqual([
      "jane@example.com",
      "support@merchant.com",
      "billing@merchant.com",
    ]);
  });

  it("parses Reply-To and exposes it as a thread participant (Shopify contact-form relay)", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        id: "thread-relay",
        historyId: "9100",
        messages: [
          {
            id: "msg-relay",
            threadId: "thread-relay",
            labelIds: ["INBOX"],
            internalDate: "1747000000000",
            payload: {
              headers: [
                { name: "From", value: "Shopify <mailer@shopify.com>" },
                { name: "Reply-To", value: '"Jane Shopper" <jane@shopper.com>' },
                { name: "To", value: "support@merchant.com" },
                { name: "Subject", value: "New contact form submission" },
                { name: "Message-ID", value: "<relay-1@shopify.com>" },
              ],
              body: { data: b64url("Customer asks: where is my order?") },
            },
          },
        ],
      }),
    );
    const thread = await gmailGetThread({
      token: "tok",
      threadId: "thread-relay",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // `from` stays the literal relay sender for fidelity...
    expect(thread.messages[0]!.from.email).toBe("mailer@shopify.com");
    // ...while `replyTo` carries the real customer.
    expect(thread.messages[0]!.replyTo).toEqual({
      name: "Jane Shopper",
      email: "jane@shopper.com",
    });
    // The customer is a thread participant so a reply can target them
    // (the recipient guard allows participants only).
    expect(thread.participants.map((p) => p.email)).toContain(
      "jane@shopper.com",
    );
    // toInboundMessage carries replyTo to the event boundary so the runtime
    // can stamp customerEmail from it.
    const inbound = toInboundMessage(thread.messages[0]!);
    expect(inbound.replyTo).toEqual({
      name: "Jane Shopper",
      email: "jane@shopper.com",
    });
  });

  it("maps 404 onto GmailHttpError with kind=not_found", async () => {
    const fetchImpl = vi.fn(async () => fail(404));
    await expect(
      gmailGetThread({
        token: "tok",
        threadId: "missing",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(GmailHttpError);
  });

  it("maps 401 onto GmailHttpError with kind=auth_failed", async () => {
    const fetchImpl = vi.fn(async () => fail(401, "unauthorized"));
    await expect(
      gmailGetThread({
        token: "bad",
        threadId: "thread-1",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "auth_failed", status: 401 },
    });
  });
});

describe("gmailListHistory — INBOX filter", () => {
  it("returns only INBOX-labelled message ids and dedupes repeats", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        historyId: "12350",
        history: [
          {
            id: "h1",
            messagesAdded: [
              { message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] } },
              { message: { id: "m2", threadId: "t1", labelIds: ["SENT"] } },
            ],
          },
          {
            id: "h2",
            messagesAdded: [
              // Duplicate of m1 (Pub/Sub at-least-once + watch overlap).
              { message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] } },
              { message: { id: "m3", threadId: "t2", labelIds: ["INBOX"] } },
            ],
          },
        ],
      }),
    );
    const result = await gmailListHistory({
      token: "tok",
      startHistoryId: "12340",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.newMessageIds).toEqual(["m1", "m3"]);
    expect(result.latestHistoryId).toBe("12350");
  });
});

describe("buildGmailMime", () => {
  it("encodes a plain-text reply with In-Reply-To threading", () => {
    const raw = buildGmailMime({
      from: { name: "Support", email: "support@merchant.com" },
      to: [{ name: "Jane", email: "jane@example.com" }],
      subject: "Re: Order #1001",
      bodyText: "We shipped it yesterday.",
      inReplyToMessageId: "abc123@mail.gmail.com",
      references: ["root@mail.gmail.com", "<abc123@mail.gmail.com>"],
    });
    const decoded = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).toContain(
      'From: "Support" <support@merchant.com>',
    );
    expect(decoded).toContain('To: "Jane" <jane@example.com>');
    expect(decoded).toContain("Subject: Re: Order #1001");
    expect(decoded).toContain("In-Reply-To: <abc123@mail.gmail.com>");
    expect(decoded).toContain(
      "References: <root@mail.gmail.com> <abc123@mail.gmail.com>",
    );
    expect(decoded).toContain("We shipped it yesterday.");
    expect(decoded).toContain("Content-Type: text/plain");
  });

  it("emits multipart/alternative when bodyHtml is provided", () => {
    const raw = buildGmailMime({
      from: { name: null, email: "support@merchant.com" },
      to: [{ name: null, email: "jane@example.com" }],
      subject: "Hi",
      bodyText: "hello",
      bodyHtml: "<p>hello</p>",
    });
    const decoded = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).toContain("Content-Type: multipart/alternative");
    expect(decoded).toContain("Content-Type: text/plain");
    expect(decoded).toContain("Content-Type: text/html");
    expect(decoded).toContain("<p>hello</p>");
  });
});

describe("gmailSendMessage", () => {
  it("POSTs raw + threadId and returns the message id", async () => {
    const fetchImpl = vi.fn(async (_url, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        raw: string;
        threadId?: string;
      };
      expect(body.raw).toBeTruthy();
      expect(body.threadId).toBe("thread-1");
      return okJson({ id: "sent-1", threadId: "thread-1" });
    });
    const result = await gmailSendMessage({
      token: "tok",
      raw: "ZW5jb2RlZA",
      threadId: "thread-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ messageId: "sent-1", threadId: "thread-1" });
  });
});

describe("gmailGetProfile", () => {
  it("returns mailbox email + current historyId", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        emailAddress: "support@merchant.com",
        historyId: "98765",
        messagesTotal: 1234,
      }),
    );
    const profile = await gmailGetProfile({
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(profile).toEqual({
      emailAddress: "support@merchant.com",
      historyId: "98765",
    });
  });

  it("throws when the response is missing required fields", async () => {
    const fetchImpl = vi.fn(async () => okJson({ messagesTotal: 0 }));
    await expect(
      gmailGetProfile({
        token: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/missing emailAddress\/historyId/);
  });
});

describe("gmailListInboxMessageIds", () => {
  it("encodes the query + maxResults and returns the message ids", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const u = typeof url === "string" ? url : url.toString();
      expect(u).toContain("/users/me/messages?");
      expect(u).toContain("q=in%3Ainbox+newer_than%3A7d");
      expect(u).toContain("maxResults=50");
      return okJson({
        messages: [
          { id: "m-1", threadId: "t-1" },
          { id: "m-2", threadId: "t-2" },
        ],
        nextPageToken: "p-1",
      });
    });
    const ids = await gmailListInboxMessageIds({
      token: "tok",
      query: "in:inbox newer_than:7d",
      maxResults: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ids).toEqual(["m-1", "m-2"]);
  });

  it("returns an empty array when Gmail finds no matches", async () => {
    const fetchImpl = vi.fn(async () => okJson({}));
    const ids = await gmailListInboxMessageIds({
      token: "tok",
      query: "in:inbox",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ids).toEqual([]);
  });
});

describe("gmailMarkMessageRead", () => {
  it("removes the UNREAD label with users.messages.modify", async () => {
    const fetchImpl = vi.fn(async (url, init: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      expect(u).toContain("/users/me/messages/m-99/modify");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({
        removeLabelIds: ["UNREAD"],
      });
      return okJson({ id: "m-99", labelIds: ["INBOX"] });
    });

    await gmailMarkMessageRead({
      token: "tok",
      messageId: "m-99",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps Gmail failures through the shared GmailHttpError path", async () => {
    const fetchImpl = vi.fn(async () => fail(401, "unauthorized"));

    await expect(
      gmailMarkMessageRead({
        token: "bad",
        messageId: "m-99",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "auth_failed", status: 401 },
    });
  });
});

describe("gmailGetMessage + toInboundMessage", () => {
  it("returns the normalised message with label-derived direction and an InboundMessage projection", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        id: "m-99",
        threadId: "t-99",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: "1747000000000",
        payload: {
          headers: [
            { name: "From", value: "jane@example.com" },
            { name: "To", value: "support@merchant.com" },
            { name: "Subject", value: "Hi" },
          ],
          body: { data: b64url("hello") },
        },
      }),
    );
    const msg = await gmailGetMessage({
      token: "tok",
      messageId: "m-99",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(msg.id).toBe("m-99");
    expect(msg.direction).toBe("inbound");
    expect(msg.labelIds).toEqual(["INBOX", "UNREAD"]);
    const inbound = toInboundMessage(msg);
    expect(inbound.messageId).toBe("m-99");
    expect(inbound.threadId).toBe("t-99");
    expect(inbound.subject).toBe("Hi");
    expect(inbound.bodyText).toBe("hello");
    expect(inbound.receivedAt.getTime()).toBe(1747000000000);
    // Ordinary mail with no Reply-To header projects a null replyTo.
    expect(inbound.replyTo).toBeNull();
  });
});
