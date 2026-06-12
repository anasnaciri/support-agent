import { describe, expect, it } from "vitest";
import {
  buildCaseTimelineHref,
  conversationThreadUnavailableView,
  curatedTimelineEvent,
  formatAttachmentSize,
  parseCaseTimelineMode,
} from "../app/cases/[id]/case-timeline.js";

describe("case timeline navigation", () => {
  it("defaults to the curated (simplified) view; full is opt-in", () => {
    expect(parseCaseTimelineMode(undefined)).toBe("simplified");
    expect(parseCaseTimelineMode("full")).toBe("full");
    expect(parseCaseTimelineMode("simplified")).toBe("simplified");
    expect(parseCaseTimelineMode("email")).toBe("email");
    expect(parseCaseTimelineMode("other")).toBe("simplified");
  });

  it("preserves other query parameters while switching modes", () => {
    const params = { takenOver: "yes", timeline: "full" };
    expect(buildCaseTimelineHref("case-1", params, "email")).toBe(
      "/cases/case-1?takenOver=yes&timeline=email",
    );
    expect(buildCaseTimelineHref("case-1", params, "full")).toBe(
      "/cases/case-1?takenOver=yes&timeline=full",
    );
    // The default (curated) view needs no query param.
    expect(buildCaseTimelineHref("case-1", params, "simplified")).toBe(
      "/cases/case-1?takenOver=yes",
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
      entry("case.escalated_to_human", { reason: "max_turns_exceeded" }),
      null,
    );
    expect(item).toMatchObject({ kind: "status" });
    const status = item as { title: string; description: string | null };
    expect(status.title.toLowerCase()).toContain("needs");
    expect(status.description ?? "").not.toContain("max_turns_exceeded");
  });

  it("quotes unknown escalation reasons verbatim", () => {
    const item = curatedTimelineEvent(
      entry("case.escalated_to_human", { reason: "weird_new_reason" }),
      null,
    );
    expect((item as { description: string | null }).description).toContain(
      "weird_new_reason",
    );
  });

  it("shows takeover, hand-back, and resolution milestones", () => {
    expect(
      curatedTimelineEvent(entry("case.taken_over", {}), null),
    ).toMatchObject({ kind: "status" });
    expect(
      curatedTimelineEvent(
        entry("case.resumed", { trigger: "dashboard_retry" }),
        null,
      ),
    ).toMatchObject({ kind: "status" });
    expect(
      curatedTimelineEvent(entry("case.resolved", {}), null),
    ).toMatchObject({ kind: "status" });
  });

  it("hides handoffs, internal tools, and runtime noise", () => {
    const hidden: ReadonlyArray<Parameters<typeof curatedTimelineEvent>[0]> = [
      entry("tool.invoked", { tool: "agent.handoff", ok: true }),
      entry("tool.invoked", { tool: "shopify.get_order", ok: true }),
      entry("tool.invoked", { tool: "knowledge.search", ok: true }),
      entry("tool.invoked", { tool: "case.update_context", ok: true }),
      entry("llm.decision", {}),
      entry("event.received", { eventType: "timer.expired" }),
      entry("event.held_human_takeover", {}),
      entry("case.waiting_for_approval", {}),
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
