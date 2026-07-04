import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { TicketId, TenantId } from "@support-agent/agent-core";
import {
  REPLY_DELIVERY_FAILED_FLAG,
  ReplyDeliveryService,
  isReplyDeliverySendFailure,
  makeReplyDeliveryServiceTest,
  nextReplyDeliveryBackoffMs,
} from "../src/reply-delivery.js";

describe("nextReplyDeliveryBackoffMs", () => {
  it("is exponential off a 60s base", () => {
    expect(nextReplyDeliveryBackoffMs(1)).toBe(60_000);
    expect(nextReplyDeliveryBackoffMs(2)).toBe(120_000);
    expect(nextReplyDeliveryBackoffMs(3)).toBe(240_000);
    expect(nextReplyDeliveryBackoffMs(4)).toBe(480_000);
  });

  it("caps at 30 minutes and floors attempt at 1", () => {
    expect(nextReplyDeliveryBackoffMs(5)).toBe(960_000);
    expect(nextReplyDeliveryBackoffMs(6)).toBe(1_800_000);
    expect(nextReplyDeliveryBackoffMs(10)).toBe(1_800_000);
    expect(nextReplyDeliveryBackoffMs(0)).toBe(60_000);
    expect(nextReplyDeliveryBackoffMs(-3)).toBe(60_000);
  });
});

describe("isReplyDeliverySendFailure", () => {
  it("matches a transport failure wrapped by the tool as ToolOutputInvalid", () => {
    // conversation.reply maps the underlying ConversationError into
    // ToolOutputInvalid { tool, issues: [e._tag] }.
    const wrapped = { _tag: "ToolOutputInvalid", issues: ["ConversationSendFailed"] };
    expect(isReplyDeliverySendFailure("conversation.reply", wrapped)).toBe(true);
    expect(
      isReplyDeliverySendFailure("conversation.ask_customer", {
        _tag: "ToolOutputInvalid",
        issues: ["ConversationProviderUnavailable"],
      }),
    ).toBe(true);
  });

  it("matches a raw ConversationError by its _tag", () => {
    expect(
      isReplyDeliverySendFailure("conversation.reply", {
        _tag: "ConversationSendFailed",
      }),
    ).toBe(true);
  });

  it("does NOT match a validation reject (recipient guard / unbound mailbox)", () => {
    // These would always fail — a retry is pointless, so they must NOT enqueue.
    expect(
      isReplyDeliverySendFailure("conversation.reply", {
        _tag: "ToolOutputInvalid",
        issues: ["mailbox_not_bound"],
      }),
    ).toBe(false);
    expect(
      isReplyDeliverySendFailure("conversation.reply", {
        _tag: "ToolOutputInvalid",
        issues: ["recipient_not_in_thread:attacker@evil.com"],
      }),
    ).toBe(false);
  });

  it("does NOT match non-send tools or junk errors", () => {
    expect(
      isReplyDeliverySendFailure("shopify.refund_customer", {
        _tag: "ToolOutputInvalid",
        issues: ["ConversationSendFailed"],
      }),
    ).toBe(false);
    expect(isReplyDeliverySendFailure("conversation.reply", null)).toBe(false);
    expect(isReplyDeliverySendFailure("conversation.reply", "oops")).toBe(false);
  });

  it("treats a NON-tagged connector error (plain Error) as a delivery failure", () => {
    // Regression for the prod miss: a send failed with a bare Error (no _tag,
    // no issues), fell through to approved_tool_failed, and the draft was lost.
    expect(
      isReplyDeliverySendFailure(
        "conversation.reply",
        new Error("connect ETIMEDOUT smtp"),
      ),
    ).toBe(true);
    expect(
      isReplyDeliverySendFailure("conversation.ask_customer", {
        code: "EAUTH",
        message: "auth failed",
      }),
    ).toBe(true);
    // A wrapper carrying an unknown _tag (not in any fixed list) still retries.
    expect(
      isReplyDeliverySendFailure("conversation.reply", {
        _tag: "ToolOutputInvalid",
        issues: ["SomethingUnexpected"],
      }),
    ).toBe(true);
  });

  it("retries a MIXED failure (a validation key plus a transport one)", () => {
    expect(
      isReplyDeliverySendFailure("conversation.reply", {
        _tag: "ToolOutputInvalid",
        issues: ["recipient_not_in_thread:a@b.com", "ConversationSendFailed"],
      }),
    ).toBe(true);
  });
});

describe("REPLY_DELIVERY_FAILED_FLAG", () => {
  it("is the stable risk-flag string the runtime stamps + dashboard renders", () => {
    expect(REPLY_DELIVERY_FAILED_FLAG).toBe("reply_delivery_failed");
  });
});

describe("makeReplyDeliveryServiceTest", () => {
  it("captures enqueue inputs for assertions", async () => {
    const { layer, handle } = makeReplyDeliveryServiceTest();
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ReplyDeliveryService;
        return yield* svc.enqueue({
          tenantId: "t1" as TenantId,
          ticketId: "c1" as TicketId,
          agentId: "order-status-agent",
          tool: "conversation.reply",
          mailbox: "support@shop.com",
          draftId: "d1",
          draft: { draftId: "d1", bodyText: "hi" },
          error: "ConversationSendFailed",
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(out.id).toBeTruthy();
    expect(handle.enqueued).toHaveLength(1);
    expect(handle.enqueued[0]!.tool).toBe("conversation.reply");
    expect(handle.enqueued[0]!.draftId).toBe("d1");
  });

  it("can be configured to fail (transient write error)", async () => {
    const { layer } = makeReplyDeliveryServiceTest({ writeFailed: true });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* ReplyDeliveryService;
        return yield* svc.enqueue({
          tenantId: "t1" as TenantId,
          ticketId: "c1" as TicketId,
          agentId: "a",
          tool: "conversation.reply",
          mailbox: null,
          draftId: "d",
          draft: {},
          error: "e",
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
