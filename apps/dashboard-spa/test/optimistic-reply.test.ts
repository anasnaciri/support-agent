import { describe, expect, it } from "vitest";
import type { DashboardConversationMessage } from "@support-agent/dashboard-contracts";

import {
  OPTIMISTIC_MESSAGE_ID_PREFIX,
  buildOptimisticOutboundMessage,
  isOptimisticMessage,
} from "../lib/optimistic-reply.js";

const inbound: DashboardConversationMessage = {
  id: "m1",
  direction: "inbound",
  from: { name: "Jane Shopper", email: "jane@example.com" },
  to: [{ name: "Store", email: "store@shop.test" }],
  subject: "Where is my order?",
  bodyText: "Hi, still waiting.",
  sanitizedBodyHtml: null,
  sentAt: "2026-07-05T10:00:00.000Z",
  attachments: [],
};
const outbound: DashboardConversationMessage = {
  ...inbound,
  id: "m2",
  direction: "outbound",
  from: { name: "Acme Support", email: "support@shop.test" },
  to: [{ name: null, email: "jane@example.com" }],
  bodyText: "Let me check!",
  sentAt: "2026-07-05T10:05:00.000Z",
};

describe("isOptimisticMessage", () => {
  it("recognizes the optimistic id prefix", () => {
    expect(isOptimisticMessage({ id: `${OPTIMISTIC_MESSAGE_ID_PREFIX}123` })).toBe(
      true,
    );
    expect(isOptimisticMessage({ id: "m1" })).toBe(false);
  });
});

describe("buildOptimisticOutboundMessage", () => {
  it("mirrors the sender of the last outbound message", () => {
    const msg = buildOptimisticOutboundMessage({
      id: `${OPTIMISTIC_MESSAGE_ID_PREFIX}1`,
      bodyText: "On its way today.",
      customerEmail: "jane@example.com",
      thread: {
        subject: "Where is my order?",
        participants: [],
        messages: [inbound, outbound],
      },
      sentAt: "2026-07-05T11:00:00.000Z",
    });
    expect(msg.direction).toBe("outbound");
    expect(msg.from).toEqual(outbound.from);
    expect(msg.to).toEqual([{ name: null, email: "jane@example.com" }]);
    expect(msg.bodyText).toBe("On its way today.");
    expect(msg.subject).toBe("Where is my order?");
    expect(msg.sanitizedBodyHtml).toBeNull();
    expect(msg.attachments).toEqual([]);
    expect(isOptimisticMessage(msg)).toBe(true);
  });

  it("falls back to a neutral sender when there is no prior outbound", () => {
    const msg = buildOptimisticOutboundMessage({
      id: `${OPTIMISTIC_MESSAGE_ID_PREFIX}2`,
      bodyText: "Hello",
      customerEmail: null,
      thread: { subject: "New", participants: [], messages: [inbound] },
      sentAt: "2026-07-05T11:00:00.000Z",
    });
    expect(msg.from).toEqual({ name: "You", email: "" });
    expect(msg.to).toEqual([]);
  });
});
