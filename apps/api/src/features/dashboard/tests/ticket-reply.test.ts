import { describe, expect, it, vi } from "vitest";
import {
  sendManualReply,
  type ManualReplyTicketView,
  type ManualReplySent,
} from "../ticket-reply.js";

const ticketView = (
  over: Partial<ManualReplyTicketView> = {},
): ManualReplyTicketView => ({
  status: "human_takeover",
  threadId: "imap:thread-1",
  mailbox: "support@shop.test",
  ...over,
});

const sent: ManualReplySent = { id: "msg-1", sentAt: "2026-06-22T10:00:00.000Z" };

describe("sendManualReply — human draft-and-send on a taken-over ticket", () => {
  it("delivers, records, and returns the sent message id", async () => {
    const deliver = vi.fn(async () => sent);
    const recordSent = vi.fn(async () => {});

    const outcome = await sendManualReply({
      bodyText: "  Hi there — your refund is on the way.  ",
      loadTicket: async () => ticketView(),
      deliver,
      recordSent,
    });

    expect(outcome).toEqual({
      kind: "sent",
      messageId: "msg-1",
      sentAt: "2026-06-22T10:00:00.000Z",
    });
    // body is trimmed before it reaches the connector
    expect(deliver).toHaveBeenCalledWith({
      threadId: "imap:thread-1",
      mailbox: "support@shop.test",
      bodyText: "Hi there — your refund is on the way.",
    });
    expect(recordSent).toHaveBeenCalledWith(sent);
  });

  it("rejects an empty body without loading the ticket", async () => {
    const loadTicket = vi.fn(async () => ticketView());
    const deliver = vi.fn(async () => sent);

    const outcome = await sendManualReply({
      bodyText: "   \n  ",
      loadTicket,
      deliver,
      recordSent: async () => {},
    });

    expect(outcome).toEqual({ kind: "empty_body" });
    expect(loadTicket).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("returns ticket_not_found when the ticket is absent / another tenant", async () => {
    const deliver = vi.fn(async () => sent);
    const outcome = await sendManualReply({
      bodyText: "hello",
      loadTicket: async () => null,
      deliver,
      recordSent: async () => {},
    });
    expect(outcome).toEqual({ kind: "ticket_not_found" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses to send unless the ticket is in human_takeover", async () => {
    const deliver = vi.fn(async () => sent);
    const outcome = await sendManualReply({
      bodyText: "hello",
      loadTicket: async () => ticketView({ status: "in_progress" }),
      deliver,
      recordSent: async () => {},
    });
    expect(outcome).toEqual({ kind: "not_in_takeover", status: "in_progress" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("returns no_thread when the ticket has no thread/mailbox to reply on", async () => {
    const deliver = vi.fn(async () => sent);
    const outcome = await sendManualReply({
      bodyText: "hello",
      loadTicket: async () => ticketView({ threadId: null }),
      deliver,
      recordSent: async () => {},
    });
    expect(outcome).toEqual({ kind: "no_thread" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reports send_failed (and skips bookkeeping) when delivery throws", async () => {
    const recordSent = vi.fn(async () => {});
    const outcome = await sendManualReply({
      bodyText: "hello",
      loadTicket: async () => ticketView(),
      deliver: async () => {
        throw new Error("ConversationSendFailed");
      },
      recordSent,
    });
    expect(outcome).toEqual({ kind: "send_failed", error: "ConversationSendFailed" });
    expect(recordSent).not.toHaveBeenCalled();
  });

  it("still reports sent when post-send bookkeeping fails (email already left)", async () => {
    const outcome = await sendManualReply({
      bodyText: "hello",
      loadTicket: async () => ticketView(),
      deliver: async () => sent,
      recordSent: async () => {
        throw new Error("audit write failed");
      },
    });
    expect(outcome).toEqual({
      kind: "sent",
      messageId: "msg-1",
      sentAt: "2026-06-22T10:00:00.000Z",
    });
  });
});
