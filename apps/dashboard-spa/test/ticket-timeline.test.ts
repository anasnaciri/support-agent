import { describe, expect, it } from "vitest";
import {
  buildTicketTimelineHref,
  chatBubbleChromeClass,
  conversationThreadUnavailableView,
  curatedTimelineEvent,
  emailHtmlHasOwnColors,
  formatAttachmentSize,
  parseTicketTimelineMode,
  replyDeliveryFailedTimelineItem,
} from "../lib/ticket-timeline.js";

describe("ticket timeline navigation", () => {
  it("defaults to the curated (simplified) view; full is opt-in", () => {
    expect(parseTicketTimelineMode(undefined)).toBe("simplified");
    expect(parseTicketTimelineMode("full")).toBe("full");
    expect(parseTicketTimelineMode("simplified")).toBe("simplified");
    expect(parseTicketTimelineMode("email")).toBe("email");
    expect(parseTicketTimelineMode("other")).toBe("simplified");
  });

  it("preserves other query parameters while switching modes", () => {
    const params = { takenOver: "yes", timeline: "full" };
    expect(buildTicketTimelineHref("ticket-1", params, "email")).toBe(
      "/tickets/ticket-1?takenOver=yes&timeline=email",
    );
    expect(buildTicketTimelineHref("ticket-1", params, "full")).toBe(
      "/tickets/ticket-1?takenOver=yes&timeline=full",
    );
    // The default (curated) view needs no query param.
    expect(buildTicketTimelineHref("ticket-1", params, "simplified")).toBe(
      "/tickets/ticket-1?takenOver=yes",
    );
  });

  it("formats attachment sizes for display", () => {
    expect(formatAttachmentSize(500)).toBe("500 B");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe("2 MB");
  });

  it("shows reconnect actions for mailbox failures that need operator action", () => {
    expect(conversationThreadUnavailableView("auth_required")).toMatchObject({
      title: "Reconnect the mailbox",
      showIntegrationsLink: true,
    });
    expect(
      conversationThreadUnavailableView("mailbox_ambiguous"),
    ).toMatchObject({
      title: "Mailbox cannot be safely identified",
      showIntegrationsLink: true,
    });
    expect(
      conversationThreadUnavailableView("provider_unavailable"),
    ).toMatchObject({
      title: "Email provider temporarily unavailable",
      showIntegrationsLink: false,
    });
  });
});

describe("emailHtmlHasOwnColors", () => {
  it("plain connector-wrapped replies carry no colors", () => {
    expect(
      emailHtmlHasOwnColors('<div dir="ltr">Sounds good, thanks!<br></div>'),
    ).toBe(false);
    expect(emailHtmlHasOwnColors("<p>Hello</p>")).toBe(false);
  });

  it("quoted-reply chrome (borders, layout) is not a color", () => {
    expect(
      emailHtmlHasOwnColors(
        '<blockquote style="border-left:1px solid #cccccc;padding-left:1ex;margin:0 0 0 .8ex">quoted</blockquote>',
      ),
    ).toBe(false);
    expect(
      emailHtmlHasOwnColors('<td style="border-color:#e0e0e0;padding:8px">cell</td>'),
    ).toBe(false);
  });

  it("detects inline text color and css backgrounds", () => {
    expect(
      emailHtmlHasOwnColors('<p style="color:#333333">designed for white</p>'),
    ).toBe(true);
    expect(
      emailHtmlHasOwnColors('<td style="background-color:#f6f6f6">x</td>'),
    ).toBe(true);
    expect(
      emailHtmlHasOwnColors('<div style="background:#fff url(hero.png)">x</div>'),
    ).toBe(true);
  });

  it("detects legacy html-mail attributes, any casing", () => {
    expect(
      emailHtmlHasOwnColors('<table BGCOLOR="#FFFFFF"><tr><td>x</td></tr></table>'),
    ).toBe(true);
    expect(emailHtmlHasOwnColors('<font color="red">deal!</font>')).toBe(true);
    expect(emailHtmlHasOwnColors('<p style="COLOR: rgb(60,60,60)">x</p>')).toBe(true);
  });
});

describe("chatBubbleChromeClass", () => {
  it("papers only inbound emails whose html styles its own colors", () => {
    expect(
      chatBubbleChromeClass({
        direction: "inbound",
        sanitizedBodyHtml:
          '<td style="background-color:#ffffff;color:#333">promo</td>',
      }),
    ).toContain("email-paper");
  });

  it("plain inbound html keeps the normal (dark-safe) bubble", () => {
    expect(
      chatBubbleChromeClass({
        direction: "inbound",
        sanitizedBodyHtml: "<p>Hello</p>",
      }),
    ).not.toContain("email-paper");
  });

  it("never papers text-only or outbound bubbles", () => {
    expect(
      chatBubbleChromeClass({
        direction: "inbound",
        sanitizedBodyHtml: null,
      }),
    ).not.toContain("email-paper");

    expect(
      chatBubbleChromeClass({
        direction: "outbound",
        sanitizedBodyHtml: '<p style="color:#333">Hello</p>',
      }),
    ).not.toContain("email-paper");
  });
});

// ------------------------------------------------------------
// Curated timeline — what a merchant sees by default. Only customer
// messages, the agent's outward findings/answers, and human
// touchpoints; never handoffs, lookups, or other internal plumbing.
// ------------------------------------------------------------
const entry = (
  action: string,
  details: unknown,
  id = "e1",
): Parameters<typeof curatedTimelineEvent>[0] => ({
  id,
  action,
  details,
  occurredAt: "2026-06-12T10:00:00.000Z",
  actorType: "agent",
  actorId: "general-inquiry-agent",
});

describe("curatedTimelineEvent", () => {
  it("shows inbound customer messages", () => {
    const item = curatedTimelineEvent(
      entry("event.received", { eventType: "message.received" }),
      "jane@example.com",
    );
    expect(item).toMatchObject({ kind: "email", title: "Email received" });
  });

  it("shows outbound replies as answers", () => {
    const item = curatedTimelineEvent(
      entry("tool.invoked", { tool: "conversation.reply", ok: true }),
      null,
    );
    expect(item).toMatchObject({ kind: "email", title: "Email sent" });
  });

  it("shows merchant.notify heads-ups with their content", () => {
    const item = curatedTimelineEvent(
      entry("tool.invoked", {
        tool: "merchant.notify",
        ok: true,
        notify: {
          title: "Shipping policy contradicts store settings",
          message: "Policy says US-only; store settings ship to Canada.",
          delivered: true,
        },
      }),
      null,
    );
    expect(item).toMatchObject({
      kind: "note",
      title: "Shipping policy contradicts store settings",
      message: "Policy says US-only; store settings ship to Canada.",
      delivered: true,
    });
  });

  it("still shows a heads-up when the audit row lacks the content (older rows)", () => {
    const item = curatedTimelineEvent(
      entry("tool.invoked", { tool: "merchant.notify", ok: true }),
      null,
    );
    expect(item).toMatchObject({ kind: "note", delivered: null });
    expect((item as { title: string }).title.length).toBeGreaterThan(0);
  });

  it("shows human escalations with merchant-friendly copy, not reason codes", () => {
    const item = curatedTimelineEvent(
      entry("ticket.escalated_to_human", { reason: "max_turns_exceeded" }),
      null,
    );
    expect(item).toMatchObject({ kind: "status" });
    const status = item as { title: string; description: string | null };
    expect(status.title.toLowerCase()).toContain("needs");
    expect(status.description ?? "").not.toContain("max_turns_exceeded");
  });

  it("humanises unknown escalation reasons instead of quoting the code", () => {
    const item = curatedTimelineEvent(
      entry("ticket.escalated_to_human", { reason: "weird_new_reason" }),
      null,
    );
    const description = (item as { description: string | null }).description;
    expect(description).toContain("Weird new reason");
    expect(description).not.toContain("weird_new_reason");
  });

  it("shows recovery-dead-end escalation reasons with specific copy", () => {
    const approvalItem = curatedTimelineEvent(
      entry("ticket.escalated_to_human", {
        reason: "approved_tool_unavailable",
      }),
      null,
    ) as { description: string | null };
    expect(approvalItem.description).toBe(
      "The approved action is no longer available.",
    );

    const supplierItem = curatedTimelineEvent(
      entry("ticket.escalated_to_human", { reason: "supplier_unreachable" }),
      null,
    ) as { description: string | null };
    expect(supplierItem.description).toBe(
      "The supplier could not be reached.",
    );
  });

  it("shows takeover, hand-back, and resolution milestones", () => {
    expect(
      curatedTimelineEvent(entry("ticket.taken_over", {}), null),
    ).toMatchObject({ kind: "status" });
    expect(
      curatedTimelineEvent(
        entry("ticket.resumed", { trigger: "dashboard_retry" }),
        null,
      ),
    ).toMatchObject({ kind: "status" });
    expect(
      curatedTimelineEvent(entry("ticket.resolved", {}), null),
    ).toMatchObject({ kind: "status" });
  });

  it("hides handoffs, internal tools, and runtime noise", () => {
    const hidden: ReadonlyArray<Parameters<typeof curatedTimelineEvent>[0]> = [
      entry("tool.invoked", { tool: "agent.handoff", ok: true }),
      entry("tool.invoked", { tool: "shopify.get_order", ok: true }),
      entry("tool.invoked", { tool: "knowledge.search", ok: true }),
      entry("tool.invoked", { tool: "ticket.update_context", ok: true }),
      entry("llm.decision", {}),
      entry("event.received", { eventType: "timer.expired" }),
      entry("event.held_human_takeover", {}),
      entry("ticket.waiting_for_approval", {}),
    ];
    for (const e of hidden) {
      expect(curatedTimelineEvent(e, null)).toBeNull();
    }
  });

  it("hides failed outbound sends (the approval card carries the story)", () => {
    expect(
      curatedTimelineEvent(
        entry("tool.invoked", { tool: "conversation.reply", ok: false }),
        null,
      ),
    ).toBeNull();
  });
});

describe("replyDeliveryFailedTimelineItem", () => {
  const delivery = {
    id: "delivery-1",
    status: "abandoned",
    lastError: "SMTP 550 mailbox unavailable",
    updatedAt: "2026-06-22T10:00:00.000Z",
  };

  it("surfaces a failed-delivery card when the ticket is parked with a retryable send", () => {
    expect(
      replyDeliveryFailedTimelineItem({
        ticketStatus: "human_takeover",
        activeReplyDelivery: delivery,
        riskFlags: [],
      }),
    ).toEqual({
      kind: "deliveryFailed",
      id: "reply-delivery-delivery-1",
      title: "Email failed to send",
      lastError: "SMTP 550 mailbox unavailable",
      occurredAt: "2026-06-22T10:00:00.000Z",
    });
  });

  it("does not surface a card once the delivery has sent", () => {
    expect(
      replyDeliveryFailedTimelineItem({
        ticketStatus: "human_takeover",
        activeReplyDelivery: { ...delivery, status: "sent" },
        riskFlags: [],
      }),
    ).toBeNull();
  });

  it("does not surface a card without an active delivery, even with the legacy flag", () => {
    expect(
      replyDeliveryFailedTimelineItem({
        ticketStatus: "human_takeover",
        activeReplyDelivery: null,
        riskFlags: ["reply_delivery_failed"],
      }),
    ).toBeNull();
  });

  it("does not surface a card while the agent still owns the ticket", () => {
    expect(
      replyDeliveryFailedTimelineItem({
        ticketStatus: "in_progress",
        activeReplyDelivery: delivery,
        riskFlags: [],
      }),
    ).toBeNull();
  });
});
