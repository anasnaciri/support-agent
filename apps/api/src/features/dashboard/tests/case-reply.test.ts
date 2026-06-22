import { describe, expect, it, vi } from "vitest";
import {
  sendManualReply,
  type ManualReplyCaseView,
  type ManualReplySent,
} from "../case-reply.js";

const caseView = (
  over: Partial<ManualReplyCaseView> = {},
): ManualReplyCaseView => ({
  status: "human_takeover",
  threadId: "imap:thread-1",
  mailbox: "support@shop.test",
  ...over,
});

const sent: ManualReplySent = { id: "msg-1", sentAt: "2026-06-22T10:00:00.000Z" };

describe("sendManualReply — human draft-and-send on a taken-over case", () => {
  it("delivers, records, and returns the sent message id", async () => {
    const deliver = vi.fn(async () => sent);
    const recordSent = vi.fn(async () => {});

    const outcome = await sendManualReply({
      bodyText: "  Hi there — your refund is on the way.  ",
      loadCase: async () => caseView(),
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

  it("rejects an empty body without loading the case", async () => {
    const loadCase = vi.fn(async () => caseView());
    const deliver = vi.fn(async () => sent);

    const outcome = await sendManualReply({
      bodyText: "   \n  ",
      loadCase,
      deliver,
      recordSent: async () => {},
    });

    expect(outcome).toEqual({ kind: "empty_body" });
    expect(loadCase).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("returns case_not_found when the case is absent / another tenant", async () => {
    const deliver = vi.fn(async () => sent);
    const outcome = await sendManualReply({
      bodyText: "hello",
      loadCase: async () => null,
      deliver,
      recordSent: async () => {},
    });
    expect(outcome).toEqual({ kind: "case_not_found" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses to send unless the case is in human_takeover", async () => {
    const deliver = vi.fn(async () => sent);
    const outcome = await sendManualReply({
      bodyText: "hello",
      loadCase: async () => caseView({ status: "in_progress" }),
      deliver,
      recordSent: async () => {},
    });
    expect(outcome).toEqual({ kind: "not_in_takeover", status: "in_progress" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("returns no_thread when the case has no thread/mailbox to reply on", async () => {
    const deliver = vi.fn(async () => sent);
    const outcome = await sendManualReply({
      bodyText: "hello",
      loadCase: async () => caseView({ threadId: null }),
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
      loadCase: async () => caseView(),
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
      loadCase: async () => caseView(),
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
