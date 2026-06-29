import { describe, expect, it, vi } from "vitest";
import { ThreadId } from "@support-agent/agent-core";
import {
  buildThread,
  makeImapSmtpOps,
  parseRawImapMessage,
  stripBrackets,
  threadRootId,
  toConversationMessage,
  type ImapSmtpConfig,
  type RawImapMessage,
} from "../src/imap-smtp.js";

const mailbox = "support@merchant.com";

const raw = (over: Partial<RawImapMessage>): RawImapMessage => ({
  uid: 1,
  messageId: "m1@host",
  inReplyTo: null,
  references: [],
  from: { name: "Jane", email: "jane@example.com" },
  replyTo: null,
  to: [{ name: null, email: mailbox }],
  subject: "Order question",
  date: new Date("2026-06-01T10:00:00Z"),
  text: "hi",
  html: null,
  ...over,
});

describe("stripBrackets", () => {
  it("removes surrounding angle brackets", () => {
    expect(stripBrackets("<abc@host>")).toBe("abc@host");
    expect(stripBrackets("abc@host")).toBe("abc@host");
  });
});

describe("threadRootId", () => {
  it("uses the first reference (conversation root) when present", () => {
    expect(threadRootId({ messageId: "m3@h", references: ["m1@h", "m2@h"] })).toBe(
      "m1@h",
    );
  });
  it("falls back to the message's own id when it is the root", () => {
    expect(threadRootId({ messageId: "m1@h", references: [] })).toBe("m1@h");
  });
});

describe("toConversationMessage", () => {
  it("marks a customer message inbound and threads on the root", () => {
    const msg = toConversationMessage(
      raw({ messageId: "m2@host", references: ["m1@host"] }),
      mailbox,
    );
    expect(msg.direction).toBe("inbound");
    expect(msg.threadId).toBe("m1@host");
    expect(msg.id).toBe("m2@host");
  });
  it("marks a message from the mailbox itself outbound", () => {
    const msg = toConversationMessage(
      raw({ from: { name: null, email: mailbox } }),
      mailbox,
    );
    expect(msg.direction).toBe("outbound");
  });
});

describe("buildThread", () => {
  it("sorts oldest → newest and collects distinct participants", () => {
    const thread = buildThread(
      [
        raw({
          messageId: "m2@host",
          references: ["m1@host"],
          date: new Date("2026-06-02T00:00:00Z"),
          subject: "Re: Order question",
        }),
        raw({
          messageId: "m1@host",
          date: new Date("2026-06-01T00:00:00Z"),
          subject: "Order question",
        }),
      ],
      "m1@host",
      mailbox,
    );
    expect(thread.id).toBe("m1@host");
    expect(thread.messages.map((m) => m.id)).toEqual(["m1@host", "m2@host"]);
    expect(thread.subject).toBe("Order question");
    expect(thread.participants.map((p) => p.email)).toEqual([
      "jane@example.com",
      mailbox,
    ]);
  });
});

describe("parseRawImapMessage", () => {
  it("parses headers, references, and the text body from raw RFC822", async () => {
    const source = Buffer.from(
      [
        "Message-ID: <m2@host>",
        "In-Reply-To: <m1@host>",
        "References: <m1@host>",
        "From: Jane Doe <jane@example.com>",
        "To: support@merchant.com",
        "Subject: Re: order",
        "Date: Mon, 01 Jun 2026 10:00:00 +0000",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Still waiting.",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const msg = await parseRawImapMessage(42, source);
    expect(msg.uid).toBe(42);
    expect(msg.messageId).toBe("m2@host");
    expect(msg.inReplyTo).toBe("m1@host");
    expect(msg.references).toEqual(["m1@host"]);
    expect(msg.from).toEqual({ name: "Jane Doe", email: "jane@example.com" });
    expect(msg.to[0]!.email).toBe("support@merchant.com");
    expect(msg.subject).toBe("Re: order");
    expect(msg.text.trim()).toBe("Still waiting.");
    expect(threadRootId(msg)).toBe("m1@host");
    // sanity: thread id construction matches the branded helper
    expect(toConversationMessage(msg, mailbox).threadId).toBe(
      ThreadId("m1@host"),
    );
  });

  it("parses Reply-To, keeping From literal but exposing the customer as a participant", async () => {
    const source = Buffer.from(
      [
        "Message-ID: <relay-1@shopify.com>",
        "From: Shopify <mailer@shopify.com>",
        "Reply-To: Jane Shopper <jane@shopper.com>",
        "To: support@merchant.com",
        "Subject: New contact form submission",
        "Date: Mon, 01 Jun 2026 10:00:00 +0000",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Where is my order?",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const msg = await parseRawImapMessage(7, source);
    expect(msg.from).toEqual({ name: "Shopify", email: "mailer@shopify.com" });
    expect(msg.replyTo).toEqual({
      name: "Jane Shopper",
      email: "jane@shopper.com",
    });
    const thread = buildThread([msg], threadRootId(msg), mailbox);
    expect(thread.messages[0]!.replyTo).toEqual({
      name: "Jane Shopper",
      email: "jane@shopper.com",
    });
    expect(thread.participants.map((p) => p.email)).toContain(
      "jane@shopper.com",
    );
  });

  it("leaves replyTo null when there is no Reply-To header", async () => {
    const source = Buffer.from(
      [
        "Message-ID: <m9@host>",
        "From: Jane <jane@example.com>",
        "To: support@merchant.com",
        "Subject: hi",
        "Date: Mon, 01 Jun 2026 10:00:00 +0000",
        "",
        "hello",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const msg = await parseRawImapMessage(9, source);
    expect(msg.replyTo).toBeNull();
  });
});

describe("makeImapSmtpOps — mailbox side effects", () => {
  const config: ImapSmtpConfig = {
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecure: true,
    user: mailbox,
    password: "secret",
    sentSaveMode: "auto",
    sentMailbox: "Sent",
  };

  const sendInput = {
    from: { name: null, email: mailbox },
    to: [{ name: "Jane", email: "jane@example.com" }],
    subject: "Re: Order question",
    text: "It shipped yesterday.",
    html: null,
    inReplyTo: "m1@host",
    references: ["m1@host"],
  };

  const makeClient = (searchResult: ReadonlyArray<number>) => {
    const append = vi.fn(async () => ({}));
    const search = vi.fn(async () => searchResult);
    const messageFlagsAdd = vi.fn(async () => true);
    return {
      client: {
        secureConnection: true,
        connect: vi.fn(async () => {}),
        logout: vi.fn(async () => {}),
        list: vi.fn(async () => [
          { path: "INBOX" },
          { path: "Sent", specialUse: "\\Sent" },
        ]),
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        search,
        fetch: vi.fn(),
        mailboxOpen: vi.fn(),
        messageFlagsAdd,
        append,
      },
      append,
      messageFlagsAdd,
      search,
    };
  };

  const makeTransport = () => {
    const sendMail = vi.fn(async (message: { messageId?: string }) => ({
      messageId: message.messageId,
    }));
    return {
      transport: {
        sendMail,
        verify: vi.fn(async () => {}),
        close: vi.fn(),
      },
      sendMail,
    };
  };

  it("uses an explicit Message-ID and does not append when Sent already has it", async () => {
    const fakeClient = makeClient([42]);
    const fakeTransport = makeTransport();
    const ops = makeImapSmtpOps(config, {
      imapFactory: () => fakeClient.client,
      smtpFactory: () => fakeTransport.transport,
      delay: async () => {},
    });

    const sent = await ops.send(sendInput);

    expect(sent.messageId).toMatch(/@/);
    const smtpMessage = fakeTransport.sendMail.mock.calls[0]![0];
    expect(smtpMessage.messageId).toBe(`<${sent.messageId}>`);
    expect(fakeClient.search).toHaveBeenCalledWith(
      { header: { "message-id": sent.messageId } },
      { uid: true },
    );
    expect(fakeClient.append).not.toHaveBeenCalled();
  });

  it("reuses the same Message-ID when the same draft is retried", async () => {
    const fakeClient = makeClient([42]);
    const fakeTransport = makeTransport();
    const ops = makeImapSmtpOps(config, {
      imapFactory: () => fakeClient.client,
      smtpFactory: () => fakeTransport.transport,
      delay: async () => {},
    });

    const first = await ops.send({ ...sendInput, idempotencyKey: "draft-1" });
    const second = await ops.send({ ...sendInput, idempotencyKey: "draft-1" });

    expect(second.messageId).toBe(first.messageId);
  });

  it("appends one Seen copy to Sent when the provider did not save the SMTP send", async () => {
    const fakeClient = makeClient([]);
    const fakeTransport = makeTransport();
    const ops = makeImapSmtpOps(config, {
      imapFactory: () => fakeClient.client,
      smtpFactory: () => fakeTransport.transport,
      delay: async () => {},
    });

    const sent = await ops.send(sendInput);

    expect(fakeClient.append).toHaveBeenCalledOnce();
    const [mailboxName, source, flags] = fakeClient.append.mock.calls[0]!;
    expect(mailboxName).toBe("Sent");
    expect(flags).toEqual(["\\Seen"]);
    expect(String(source)).toContain(`Message-ID: <${sent.messageId}>`);
    expect(String(source)).toContain("In-Reply-To: <m1@host>");
    expect(String(source)).toContain("It shipped yesterday.");
  });

  it("skips IMAP Sent writes when the connection is configured for provider-side saving", async () => {
    const fakeClient = makeClient([]);
    const fakeTransport = makeTransport();
    const ops = makeImapSmtpOps(
      { ...config, sentSaveMode: "smtp_provider" },
      {
        imapFactory: () => fakeClient.client,
        smtpFactory: () => fakeTransport.transport,
        delay: async () => {},
      },
    );

    await ops.send(sendInput);

    expect(fakeClient.search).not.toHaveBeenCalled();
    expect(fakeClient.append).not.toHaveBeenCalled();
  });

  it("marks accepted inbound INBOX UIDs as read", async () => {
    const fakeClient = makeClient([]);
    const fakeTransport = makeTransport();
    const ops = makeImapSmtpOps(config, {
      imapFactory: () => fakeClient.client,
      smtpFactory: () => fakeTransport.transport,
      delay: async () => {},
    });

    await ops.markRead([9, 9, 10]);

    expect(fakeClient.messageFlagsAdd).toHaveBeenCalledWith(
      [9, 10],
      ["\\Seen"],
      { uid: true },
    );
  });
});
