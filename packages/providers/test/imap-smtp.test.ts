import { describe, expect, it } from "vitest";
import { ThreadId } from "@support-agent/agent-core";
import {
  buildThread,
  parseRawImapMessage,
  stripBrackets,
  threadRootId,
  toConversationMessage,
  type RawImapMessage,
} from "../src/imap-smtp.js";

const mailbox = "support@merchant.com";

const raw = (over: Partial<RawImapMessage>): RawImapMessage => ({
  uid: 1,
  messageId: "m1@host",
  inReplyTo: null,
  references: [],
  from: { name: "Jane", email: "jane@example.com" },
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
});
