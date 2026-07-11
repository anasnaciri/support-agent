import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId, TicketId } from "@support-agent/agent-core";
import {
  MerchantNotificationService,
  MerchantNotificationSendFailed,
  approvalRequestedNotification,
  bundleApprovalRequestedNotification,
  connectorBrokenNotification,
  humanTakeoverNotification,
  llmCreditsLowNotification,
  makeMerchantNotificationServiceTest,
  summarizeApprovalAction,
  type MerchantNotification,
} from "../src/index.js";

const t1 = TenantId("t1");

const note: MerchantNotification = {
  kind: "agent_note",
  title: "Agent needs a sanity check",
  body: "Customer claims a promo code that isn't in the knowledge base.",
  ticketId: TicketId("c1"),
};

describe("MerchantNotificationService test layer", () => {
  it("records every notify call and reports telegram delivery", async () => {
    const { layer, handle } = makeMerchantNotificationServiceTest();
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MerchantNotificationService;
          return yield* svc.notify(t1, note);
        }),
        layer,
      ),
    );
    expect(result).toEqual({ delivered: true, channel: "telegram" });
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]?.tenantId).toBe(t1);
    expect(handle.sent[0]?.notification.kind).toBe("agent_note");
    expect(handle.sent[0]?.notification.title).toContain("sanity check");
  });

  it("reports delivered:false for tenants without a connected channel", async () => {
    const { layer, handle } = makeMerchantNotificationServiceTest({
      disconnectedFor: new Set([t1]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MerchantNotificationService;
          return yield* svc.notify(t1, note);
        }),
        layer,
      ),
    );
    expect(result).toEqual({ delivered: false, channel: null });
    // The attempt is still recorded so tests can assert the caller tried.
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]?.result.delivered).toBe(false);
  });

  it("fails with MerchantNotificationSendFailed when failAll is set", async () => {
    const { layer, handle } = makeMerchantNotificationServiceTest({
      failAll: true,
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MerchantNotificationService;
          return yield* svc.notify(t1, note);
        }),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = exit.cause;
      expect(JSON.stringify(failure)).toContain(
        "MerchantNotificationSendFailed",
      );
    }
    expect(handle.sent).toHaveLength(0);
  });

  it("accepts notifications without a ticketId (account-level alerts)", async () => {
    const { layer, handle } = makeMerchantNotificationServiceTest();
    const accountAlert: MerchantNotification = {
      kind: "llm_credits_low",
      title: "OpenRouter credits running low",
      body: "Remaining balance is $3.20. Top up to keep the agent running.",
    };
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MerchantNotificationService;
          return yield* svc.notify(t1, accountAlert);
        }),
        layer,
      ),
    );
    expect(result.delivered).toBe(true);
    expect(handle.sent[0]?.notification.ticketId).toBeUndefined();
  });
});

describe("MerchantNotificationSendFailed", () => {
  it("is a tagged error carrying the tenant", () => {
    const err = new MerchantNotificationSendFailed({
      tenantId: t1,
      cause: "boom",
    });
    expect(err._tag).toBe("MerchantNotificationSendFailed");
    expect(err.tenantId).toBe(t1);
  });
});

describe("approvalRequestedNotification", () => {
  const base = {
    ticketId: TicketId("c1"),
    toolName: "conversation.reply",
    draftSubject: "Re: refund for #1001",
    draftPreview: "Hi Jane — we can refund order #1001 on receipt.",
    approveUrl: "https://api.example.com/approvals/a1/approve?token=A",
    rejectUrl: "https://api.example.com/approvals/a1/reject?token=R",
  };

  it("carries the draft preview and both decision links", () => {
    const n = approvalRequestedNotification(base);
    expect(n.kind).toBe("approval_requested");
    expect(n.ticketId).toBe(base.ticketId);
    expect(n.title).toContain("Re: refund for #1001");
    expect(n.body).toContain(base.draftPreview);
    expect(n.body).toContain(base.approveUrl);
    expect(n.body).toContain(base.rejectUrl);
    expect(n.body).toContain("conversation.reply");
  });

  it("falls back to the tool name when the draft has no subject", () => {
    const n = approvalRequestedNotification({ ...base, draftSubject: null });
    expect(n.title).toContain("conversation.reply");
  });
});

describe("humanTakeoverNotification", () => {
  it("maps known escalation reasons to merchant-friendly copy", () => {
    const n = humanTakeoverNotification({
      ticketId: TicketId("c1"),
      subject: "Where is my order?",
      reason: "max_turns_exceeded",
    });
    expect(n.kind).toBe("human_takeover");
    expect(n.ticketId).toBe(TicketId("c1"));
    expect(n.body).toContain("Where is my order?");
    // Friendly copy, not the internal reason code.
    expect(n.body).not.toContain("max_turns_exceeded");
    expect(n.body.toLowerCase()).toContain("dashboard");
  });

  it("points at the provider key settings for credential escalations", () => {
    const n = humanTakeoverNotification({
      ticketId: TicketId("c1"),
      subject: null,
      reason: "llm_credential_missing",
    });
    expect(n.body.toLowerCase()).toContain("key");
  });

  it("falls back to quoting an unknown reason verbatim", () => {
    const n = humanTakeoverNotification({
      ticketId: TicketId("c1"),
      subject: null,
      reason: "weird_new_reason",
    });
    expect(n.body).toContain("weird_new_reason");
  });
});

describe("llmCreditsLowNotification", () => {
  it("states the remaining balance, the threshold, and what happens at zero", () => {
    const n = llmCreditsLowNotification({
      provider: "openrouter",
      remainingUsd: 3.204,
      thresholdUsd: 5,
    });
    expect(n.kind).toBe("llm_credits_low");
    expect(n.ticketId).toBeUndefined();
    expect(n.body).toContain("$3.20");
    expect(n.body).toContain("$5");
    expect(n.body.toLowerCase()).toContain("openrouter");
  });
});

describe("connectorBrokenNotification", () => {
  it("names the provider + mailbox and says inbound mail is stopped", () => {
    const n = connectorBrokenNotification({
      provider: "outlook",
      mailbox: "support@merchant.com",
      reason: "refresh token revoked",
    });
    expect(n.kind).toBe("connector_broken");
    expect(n.ticketId).toBeUndefined();
    expect(n.title).toContain("outlook");
    expect(n.body).toContain("support@merchant.com");
    expect(n.body).toContain("refresh token revoked");
    expect(n.body.toLowerCase()).toContain("not");
  });
});

describe("summarizeApprovalAction", () => {
  it("summarizes a reply with a short quoted preview", () => {
    const line = summarizeApprovalAction("conversation.reply", {
      subject: "Re: order #1001",
      bodyText:
        "Hi Jane, sorry about the delay — your replacement ships tomorrow and you'll get tracking by email.",
    });
    expect(line).toContain("Reply to the customer");
    expect(line).toContain("Hi Jane, sorry about the delay");
    // Long drafts are truncated to keep the ping scannable.
    expect(line.length).toBeLessThan(140);
  });

  it("summarizes a refund with amount and currency from the input", () => {
    const line = summarizeApprovalAction("refund.create", {
      orderId: "gid://shopify/Order/123",
      amount: { amount: "23.50", currencyCode: "EUR" },
    });
    expect(line).toContain("Issue a refund");
    expect(line).toContain("23.50 EUR");
    // Raw GIDs are jargon — never surfaced to the merchant.
    expect(line).not.toContain("gid://");
  });

  it("never invents a currency when the input has none", () => {
    const line = summarizeApprovalAction("refund.create", {
      orderId: "gid://shopify/Order/123",
    });
    expect(line).toContain("Issue a refund");
    expect(line).not.toContain("USD");
  });

  it("summarizes an order cancellation", () => {
    const line = summarizeApprovalAction("order.cancel", {
      orderId: "gid://shopify/Order/123",
      amount: { amount: "80.00", currencyCode: "GBP" },
    });
    expect(line).toContain("Cancel and refund the order");
    expect(line).toContain("80.00 GBP");
    expect(line).not.toContain("gid://");
  });

  it("summarizes percentage and fixed-amount discounts", () => {
    expect(
      summarizeApprovalAction("discount.create", {
        valueType: "percentage",
        value: "15",
      }),
    ).toContain("15%");
    expect(
      summarizeApprovalAction("discount.create", {
        valueType: "fixed_amount",
        value: "10.00",
        currencyCode: "EUR",
      }),
    ).toContain("10.00 EUR");
  });

  it("summarizes a shipping-address update with the destination", () => {
    // A merchant approving a redirect must see WHERE the parcel would go —
    // the street + city, never the raw GID.
    const line = summarizeApprovalAction("order.update_shipping_address", {
      orderId: "gid://shopify/Order/123",
      address1: "500 New St",
      city: "Austin",
      province: "TX",
      zip: "78701",
    });
    expect(line).toContain("Update the shipping address");
    expect(line).toContain("500 New St");
    expect(line).toContain("Austin");
    expect(line).not.toContain("gid://");
  });

  it("keeps the bare label when the address edit carries no locatable fields", () => {
    const line = summarizeApprovalAction("order.update_shipping_address", {
      orderId: "gid://shopify/Order/123",
      phone: "+1 555 0100",
    });
    expect(line).toBe("Update the shipping address");
  });

  it("falls back to the tool id for unknown tools", () => {
    const line = summarizeApprovalAction("some.future_tool", { x: 1 });
    expect(line).toContain("some.future_tool");
  });
});

describe("bundleApprovalRequestedNotification", () => {
  const base = {
    ticketId: TicketId("c1"),
    ticketSubject: "Where is my order?",
    customerEmail: "jane@example.com",
    actions: [
      {
        tool: "conversation.reply",
        proposedInput: { bodyText: "Hi Jane, here's an update." },
      },
      {
        tool: "refund.create",
        proposedInput: {
          orderId: "gid://shopify/Order/123",
          amount: { amount: "23.50", currencyCode: "EUR" },
        },
      },
    ],
    reviewUrl: "https://api.example.com/approvals/bundle/c1?token=T",
  };

  it("lists every queued action with the customer and one review link", () => {
    const n = bundleApprovalRequestedNotification(base);
    expect(n.kind).toBe("approval_requested");
    expect(n.ticketId).toBe(base.ticketId);
    expect(n.title).toContain("Where is my order?");
    expect(n.body).toContain("jane@example.com");
    expect(n.body).toContain("2 actions");
    expect(n.body).toContain("1. ");
    expect(n.body).toContain("2. ");
    expect(n.body).toContain("Hi Jane, here's an update.");
    expect(n.body).toContain("23.50 EUR");
    expect(n.body).toContain(base.reviewUrl);
    // The review page is the single decision surface — no bare
    // approve/reject links that would decide sight-unseen.
    expect(n.body.match(/https?:\/\//gu)).toHaveLength(1);
  });

  it("omits the customer line when unknown and falls back to the action count in the title", () => {
    const n = bundleApprovalRequestedNotification({
      ...base,
      ticketSubject: null,
      customerEmail: null,
    });
    expect(n.title).toContain("2 actions");
    expect(n.body).not.toContain("Customer:");
  });
});
