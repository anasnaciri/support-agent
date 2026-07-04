import { describe, expect, it } from "vitest";
import type { DueReplyDelivery } from "@support-agent/db";
import {
  fireReplyDeliveryRetryOnce,
  type ReplyDeliveryRetryDeps,
  type ReplySendOutcome,
} from "../src/reply-delivery-retry-schedule.js";

const due = (over: Partial<DueReplyDelivery> = {}): DueReplyDelivery => ({
  id: "rd-1",
  tenantId: "t1",
  ticketId: "c1",
  agentId: "order-status-agent",
  tool: "conversation.reply",
  mailbox: "support@shop.com",
  draftId: "d1",
  draft: { draftId: "d1", threadId: "th1", bodyText: "hi", to: [] },
  attempts: 1,
  maxAttempts: 6,
  ...over,
});

const makeDeps = (
  rows: ReadonlyArray<DueReplyDelivery>,
  sendImpl: (d: DueReplyDelivery) => ReplySendOutcome,
) => {
  const calls = {
    sent: [] as string[],
    resolved: [] as string[],
    failed: [] as Array<{ id: string; attempt: number }>,
    abandoned: [] as string[],
  };
  const deps: ReplyDeliveryRetryDeps = {
    listDue: () => Promise.resolve(rows),
    send: (d) => Promise.resolve(sendImpl(d)),
    markSent: (id) => {
      calls.sent.push(id);
      return Promise.resolve();
    },
    resolveTicket: (ticketId) => {
      calls.resolved.push(ticketId);
      return Promise.resolve();
    },
    recordFailure: (id, _err, attempt) => {
      calls.failed.push({ id, attempt });
      return Promise.resolve();
    },
    abandon: (id) => {
      calls.abandoned.push(id);
      return Promise.resolve();
    },
  };
  return { deps, calls };
};

describe("fireReplyDeliveryRetryOnce", () => {
  it("on a successful re-send: marks sent + auto-resolves the ticket", async () => {
    const { deps, calls } = makeDeps([due()], () => "sent");
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out).toEqual({ sent: 1, failed: 0, abandoned: 0, skipped: 0 });
    expect(calls.sent).toEqual(["rd-1"]);
    expect(calls.resolved).toEqual(["c1"]);
    expect(calls.failed).toHaveLength(0);
    expect(calls.abandoned).toHaveLength(0);
  });

  it("on a failure under the cap: records the failure with the next attempt number", async () => {
    const { deps, calls } = makeDeps([due({ attempts: 2 })], () => ({
      error: "ConversationSendFailed",
    }));
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out.failed).toBe(1);
    expect(out.abandoned).toBe(0);
    expect(calls.failed).toEqual([{ id: "rd-1", attempt: 3 }]);
    expect(calls.resolved).toHaveLength(0);
    expect(calls.sent).toHaveLength(0);
  });

  it("on a failure at the cap (attempts+1 >= maxAttempts): abandons the row", async () => {
    const { deps, calls } = makeDeps(
      [due({ attempts: 5, maxAttempts: 6 })],
      () => ({ error: "still failing" }),
    );
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out.abandoned).toBe(1);
    expect(out.failed).toBe(0);
    expect(calls.abandoned).toEqual(["rd-1"]);
    expect(calls.failed).toHaveLength(0);
  });

  it("skips re-sending when the ticket moved on (human handled it): marks sent, no resolve", async () => {
    const { deps, calls } = makeDeps([due()], () => "skip");
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out.skipped).toBe(1);
    expect(calls.sent).toEqual(["rd-1"]);
    expect(calls.resolved).toHaveLength(0);
    expect(calls.failed).toHaveLength(0);
    expect(calls.abandoned).toHaveLength(0);
  });

  it("processes a mixed batch independently", async () => {
    const rows = [
      due({ id: "ok", ticketId: "cok" }),
      due({ id: "retry", ticketId: "cr", attempts: 1 }),
      due({ id: "cap", ticketId: "cc", attempts: 5 }),
    ];
    const { deps, calls } = makeDeps(rows, (d) =>
      d.id === "ok" ? "sent" : { error: "boom" },
    );
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out).toEqual({ sent: 1, failed: 1, abandoned: 1, skipped: 0 });
    expect(calls.sent).toEqual(["ok"]);
    expect(calls.resolved).toEqual(["cok"]);
    expect(calls.failed).toEqual([{ id: "retry", attempt: 2 }]);
    expect(calls.abandoned).toEqual(["cap"]);
  });
});
